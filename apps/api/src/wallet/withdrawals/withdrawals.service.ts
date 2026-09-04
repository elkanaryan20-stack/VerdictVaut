import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { LedgerEntryType, Prisma, WithdrawalStatus } from "@prisma/client";
import { LedgerService } from "../../ledger/ledger.service";
import { PrismaService } from "../../prisma/prisma.service";
import { WithdrawalExecutorFactory } from "../executors/withdrawal-executor.factory";
import { RequestWithdrawalDto } from "./dto/request-withdrawal.dto";

/**
 * Explicit withdrawal state machine:
 *
 *   REQUESTED -> RISK_REVIEW -> APPROVED
 *     -> PENDING_MANUAL_BROADCAST -> BROADCAST   (sandbox / ManualBroadcastExecutor)
 *     -> BROADCASTING             -> BROADCAST   (production / ProductionCustodyExecutor)
 *   BROADCAST -> CONFIRMING -> CONFIRMED -> CREDITED
 *   (any stage) -> REJECTED | FAILED  — releases the balance hold
 *
 * The balance is reserved with a WITHDRAWAL_HOLD ledger entry at request
 * time (funds leave "available" immediately) and only ever released back
 * via WITHDRAWAL_RELEASE on rejection/failure. Confirmation does not move
 * money again — it just finalizes the record — because the hold already
 * did.
 */
@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly executorFactory: WithdrawalExecutorFactory,
  ) {}

  async request(userId: string, dto: RequestWithdrawalDto) {
    const asset = await this.prisma.asset.findUnique({ where: { symbol: dto.assetSymbol } });
    const network = await this.prisma.network.findUnique({ where: { code: dto.networkCode } });
    if (!asset || !network) {
      throw new BadRequestException("Unknown asset symbol or network code");
    }

    const assetNetwork = await this.prisma.assetNetwork.findUnique({
      where: { assetId_networkId: { assetId: asset.id, networkId: network.id } },
    });
    if (!assetNetwork || !assetNetwork.isActive) {
      throw new BadRequestException(`${dto.assetSymbol} withdrawals are not currently supported on ${dto.networkCode}`);
    }

    const amount = new Prisma.Decimal(dto.amount);
    if (amount.lessThanOrEqualTo(assetNetwork.withdrawalMinAmount)) {
      throw new BadRequestException(`Amount must be greater than the minimum withdrawal of ${assetNetwork.withdrawalMinAmount}`);
    }

    if (assetNetwork.memoRequired && !dto.destinationTag) {
      throw new BadRequestException(`${dto.networkCode} requires a destination tag/memo`);
    }

    return this.prisma.$transaction(async (tx) => {
      const withdrawal = await tx.withdrawal.create({
        data: {
          userId,
          assetNetworkId: assetNetwork.id,
          destinationAddress: dto.destinationAddress,
          destinationTag: dto.destinationTag,
          amount,
          status: WithdrawalStatus.REQUESTED,
        },
      });

      // Reserve funds immediately so they cannot be double-spent by a
      // concurrent withdrawal or trade while this one is under review.
      await this.ledger.postEntry(
        {
          userId,
          assetSymbol: asset.symbol,
          amount: amount.negated(),
          type: LedgerEntryType.WITHDRAWAL_HOLD,
          referenceType: "Withdrawal",
          referenceId: withdrawal.id,
        },
        tx,
      );

      return tx.withdrawal.update({ where: { id: withdrawal.id }, data: { status: WithdrawalStatus.RISK_REVIEW } });
    });
  }

  async approve(withdrawalId: string) {
    const withdrawal = await this.getOrThrow(withdrawalId);
    this.assertStatus(withdrawal.status, [WithdrawalStatus.RISK_REVIEW]);

    await this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: WithdrawalStatus.APPROVED },
    });

    const executor = await this.executorFactory.resolve(withdrawal.assetNetworkId);
    const result = await executor.execute({
      withdrawalId: withdrawal.id,
      assetNetworkId: withdrawal.assetNetworkId,
      destinationAddress: withdrawal.destinationAddress,
      destinationTag: withdrawal.destinationTag,
      amount: withdrawal.amount.toString(),
    });

    if (result.status === "broadcast") {
      return this.prisma.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.BROADCAST, txHash: result.txHash, broadcastAt: new Date() },
      });
    }

    return this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: WithdrawalStatus.PENDING_MANUAL_BROADCAST },
    });
  }

  /** Admin submits the tx hash after broadcasting a sandbox withdrawal themselves. */
  async recordManualBroadcast(withdrawalId: string, adminId: string, txHash: string) {
    const withdrawal = await this.getOrThrow(withdrawalId);
    this.assertStatus(withdrawal.status, [WithdrawalStatus.PENDING_MANUAL_BROADCAST]);

    return this.prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: WithdrawalStatus.BROADCAST,
        txHash,
        broadcastByAdminId: adminId,
        broadcastAt: new Date(),
      },
    });
  }

  /** Called by the (future) confirmation watcher with real on-chain confirmation counts. */
  async recordConfirmation(withdrawalId: string, confirmations: number, requiredConfirmations: number) {
    const withdrawal = await this.getOrThrow(withdrawalId);
    this.assertStatus(withdrawal.status, [WithdrawalStatus.BROADCAST, WithdrawalStatus.CONFIRMING]);

    if (confirmations < requiredConfirmations) {
      return this.prisma.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.CONFIRMING },
      });
    }

    return this.prisma.$transaction(async (tx) => {
      await this.ledger.postEntry(
        {
          userId: withdrawal.userId,
          assetSymbol: (await tx.assetNetwork.findUniqueOrThrow({
            where: { id: withdrawal.assetNetworkId },
            include: { asset: true },
          })).asset.symbol,
          amount: 0,
          type: LedgerEntryType.WITHDRAWAL,
          referenceType: "Withdrawal",
          referenceId: withdrawal.id,
        },
        tx,
      );

      return tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.CREDITED, confirmedAt: new Date() },
      });
    });
  }

  async reject(withdrawalId: string, reason: string) {
    return this.releaseHold(withdrawalId, reason, WithdrawalStatus.REJECTED, [
      WithdrawalStatus.REQUESTED,
      WithdrawalStatus.RISK_REVIEW,
      WithdrawalStatus.APPROVED,
    ]);
  }

  async fail(withdrawalId: string, reason: string) {
    return this.releaseHold(withdrawalId, reason, WithdrawalStatus.FAILED, [
      WithdrawalStatus.APPROVED,
      WithdrawalStatus.PENDING_MANUAL_BROADCAST,
      WithdrawalStatus.BROADCASTING,
      WithdrawalStatus.BROADCAST,
      WithdrawalStatus.CONFIRMING,
    ]);
  }

  private async releaseHold(
    withdrawalId: string,
    reason: string,
    terminalStatus: WithdrawalStatus,
    allowedFrom: WithdrawalStatus[],
  ) {
    const withdrawal = await this.getOrThrow(withdrawalId);
    this.assertStatus(withdrawal.status, allowedFrom);

    return this.prisma.$transaction(async (tx) => {
      const assetNetwork = await tx.assetNetwork.findUniqueOrThrow({
        where: { id: withdrawal.assetNetworkId },
        include: { asset: true },
      });

      await this.ledger.postEntry(
        {
          userId: withdrawal.userId,
          assetSymbol: assetNetwork.asset.symbol,
          amount: withdrawal.amount,
          type: LedgerEntryType.WITHDRAWAL_RELEASE,
          referenceType: "Withdrawal",
          referenceId: withdrawal.id,
        },
        tx,
      );

      return tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: terminalStatus, failureReason: reason },
      });
    });
  }

  async listMine(userId: string) {
    return this.prisma.withdrawal.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  async listAll() {
    return this.prisma.withdrawal.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: { select: { id: true, email: true } }, assetNetwork: { include: { asset: true, network: true } } },
    });
  }

  private async getOrThrow(withdrawalId: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) {
      throw new NotFoundException("Withdrawal not found");
    }
    return withdrawal;
  }

  private assertStatus(current: WithdrawalStatus, allowed: WithdrawalStatus[]) {
    if (!allowed.includes(current)) {
      throw new BadRequestException(`Withdrawal is in status ${current}, expected one of: ${allowed.join(", ")}`);
    }
  }
}
