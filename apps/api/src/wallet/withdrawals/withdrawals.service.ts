import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, UserStatus, Withdrawal, WithdrawalStatus } from "@prisma/client";
import { AuditLogService } from "../../audit/audit-log.service";
import { LedgerService } from "../../ledger/ledger.service";
import { ReservationService } from "../../ledger/reservation.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";
import { WithdrawalExecutorFactory } from "../executors/withdrawal-executor.factory";
import { assertValidDestinationAddress } from "./destination-address.validator";
import { RequestWithdrawalDto } from "./dto/request-withdrawal.dto";

/**
 * Explicit withdrawal state machine:
 *
 *   REQUESTED -> RISK_REVIEW -> APPROVED
 *     -> PENDING_MANUAL_BROADCAST -> BROADCAST   (sandbox / ManualBroadcastExecutor)
 *     -> BROADCASTING             -> BROADCAST   (production / ProductionCustodyExecutor)
 *   BROADCAST -> CONFIRMING -> CONFIRMED -> CREDITED
 *   (any stage) -> REJECTED | FAILED  — releases the reservation
 *
 * Funds are RESERVED (not moved) at request time via FundReservation —
 * this immediately reduces what's available without touching total
 * balance, because nothing has actually left the system yet. The
 * reservation is only ever released (reject/fail) or captured
 * (confirmed — at which point a real LedgerTransaction finally moves the
 * total balance to the EXTERNAL_CHAIN house account, because that's the
 * point real funds left).
 *
 * Every state transition below is a guarded compare-and-swap: the DB
 * update's WHERE clause requires the row to still be in the expected
 * prior status, and a 0-row result means a concurrent call already
 * transitioned it — so two concurrent (or double-clicked/retried) calls
 * to approve/reject/fail/broadcast can never both succeed, and a
 * reservation can never be released or captured twice.
 */
@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly reservations: ReservationService,
    private readonly executorFactory: WithdrawalExecutorFactory,
    private readonly txRunner: SerializableTransactionRunner,
    private readonly auditLog: AuditLogService,
  ) {}

  async request(userId: string, dto: RequestWithdrawalDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException("Account must be verified (ACTIVE) before withdrawing funds");
    }

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

    assertValidDestinationAddress(network.family, dto.destinationAddress);

    const withdrawal = await this.txRunner.run(async (tx) => {
      const created = await tx.withdrawal.create({
        data: {
          userId,
          assetNetworkId: assetNetwork.id,
          destinationAddress: dto.destinationAddress,
          destinationTag: dto.destinationTag,
          amount,
          status: WithdrawalStatus.REQUESTED,
        },
      });

      // Earmarks the funds (reservedBalance) — total balance is untouched
      // until the withdrawal is actually confirmed on-chain.
      await this.reservations.reserve(tx, {
        userId,
        assetSymbol: asset.symbol,
        amount,
        referenceType: "Withdrawal",
        referenceId: created.id,
        idempotencyKey: `withdrawal-reserve:${created.id}`,
      });

      return tx.withdrawal.update({ where: { id: created.id }, data: { status: WithdrawalStatus.RISK_REVIEW } });
    });

    await this.auditLog.record({
      actorId: userId,
      actorType: "USER",
      action: "withdrawal.request",
      resourceType: "Withdrawal",
      resourceId: withdrawal.id,
      after: { status: withdrawal.status, amount: withdrawal.amount.toString(), assetSymbol: asset.symbol, networkCode: network.code },
      idempotencyKey: withdrawal.id,
    });

    return withdrawal;
  }

  async getById(withdrawalId: string) {
    return this.getOrThrow(withdrawalId);
  }

  async approve(withdrawalId: string) {
    await this.txRunner.run((tx) =>
      this.casTransition(tx, withdrawalId, [WithdrawalStatus.RISK_REVIEW], { status: WithdrawalStatus.APPROVED }),
    );

    // The executor call happens outside the DB transaction (it may be a
    // slow external call once a real custody provider exists) — that's
    // safe because the CAS above already gave exactly one caller
    // exclusive ownership of this transition; a concurrent approve() call
    // would have failed the CAS and never reached here.
    const withdrawal = await this.getOrThrow(withdrawalId);
    const executor = await this.executorFactory.resolve(withdrawal.assetNetworkId);
    const result = await executor.execute({
      withdrawalId: withdrawal.id,
      assetNetworkId: withdrawal.assetNetworkId,
      destinationAddress: withdrawal.destinationAddress,
      destinationTag: withdrawal.destinationTag,
      amount: withdrawal.amount.toString(),
      idempotencyKey: withdrawal.id,
    });

    if (result.status === "broadcast") {
      return this.txRunner.run((tx) =>
        this.casTransition(tx, withdrawalId, [WithdrawalStatus.APPROVED], {
          status: WithdrawalStatus.BROADCAST,
          txHash: result.txHash,
          broadcastAt: new Date(),
        }),
      );
    }

    return this.txRunner.run((tx) =>
      this.casTransition(tx, withdrawalId, [WithdrawalStatus.APPROVED], {
        status: WithdrawalStatus.PENDING_MANUAL_BROADCAST,
      }),
    );
  }

  /** Admin submits the tx hash after broadcasting a sandbox withdrawal themselves. */
  async recordManualBroadcast(withdrawalId: string, adminId: string, txHash: string) {
    return this.txRunner.run((tx) =>
      this.casTransition(tx, withdrawalId, [WithdrawalStatus.PENDING_MANUAL_BROADCAST], {
        status: WithdrawalStatus.BROADCAST,
        txHash,
        broadcastByAdminId: adminId,
        broadcastAt: new Date(),
      }),
    );
  }

  /**
   * Called by the (future) confirmation watcher with real on-chain
   * confirmation counts. Safe to call repeatedly with the same or stale
   * data — insufficient confirmations just re-affirms CONFIRMING, and a
   * withdrawal that's already CONFIRMED/CREDITED is left untouched rather
   * than erroring, since watchers naturally re-poll and redeliver.
   */
  async recordConfirmation(withdrawalId: string, confirmations: number, requiredConfirmations: number) {
    if (confirmations < requiredConfirmations) {
      return this.txRunner.run(async (tx) => {
        const result = await tx.withdrawal.updateMany({
          where: { id: withdrawalId, status: { in: [WithdrawalStatus.BROADCAST, WithdrawalStatus.CONFIRMING] } },
          data: { status: WithdrawalStatus.CONFIRMING },
        });
        if (result.count === 0) {
          return this.getOrThrow(withdrawalId, tx);
        }
        return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      });
    }

    const { withdrawal: settled, justCredited } = await this.txRunner.run(async (tx) => {
      const result = await tx.withdrawal.updateMany({
        where: { id: withdrawalId, status: { in: [WithdrawalStatus.BROADCAST, WithdrawalStatus.CONFIRMING] } },
        data: { status: WithdrawalStatus.CONFIRMED, confirmedAt: new Date() },
      });

      if (result.count === 0) {
        // Already confirmed/credited by an earlier or concurrent call —
        // idempotent no-op, not an error.
        return { withdrawal: await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } }), justCredited: false };
      }

      const withdrawal = await tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
      const assetNetwork = await tx.assetNetwork.findUniqueOrThrow({
        where: { id: withdrawal.assetNetworkId },
        include: { asset: true },
      });

      const reservation = await this.reservations.findActiveByReference(tx, "Withdrawal", withdrawalId);
      if (reservation) {
        await this.reservations.capture(tx, reservation.id);
      }

      // The real, total-balance-moving posting — this is the point actual
      // funds left the platform, so it's the point the ledger moves money,
      // not the earlier reservation.
      await this.ledger.postTransaction(tx, {
        assetSymbol: assetNetwork.asset.symbol,
        type: "WITHDRAWAL",
        referenceType: "Withdrawal",
        referenceId: withdrawalId,
        idempotencyKey: `withdrawal-capture:${withdrawalId}`,
        postings: [
          { account: { type: "USER", userId: withdrawal.userId }, amount: withdrawal.amount.negated() },
          { account: { type: "HOUSE", key: "EXTERNAL_CHAIN" }, amount: withdrawal.amount },
        ],
      });

      const credited = await tx.withdrawal.update({
        where: { id: withdrawalId },
        data: { status: WithdrawalStatus.CREDITED },
      });

      return { withdrawal: credited, justCredited: true };
    });

    if (justCredited) {
      await this.auditLog.record({
        actorType: "SYSTEM",
        action: "withdrawal.confirmed",
        resourceType: "Withdrawal",
        resourceId: settled.id,
        before: { status: "BROADCAST_OR_CONFIRMING" },
        after: { status: settled.status },
        idempotencyKey: `withdrawal-capture:${settled.id}`,
      });
    }

    return settled;
  }

  async reject(withdrawalId: string, reason: string) {
    return this.releaseReservation(withdrawalId, reason, WithdrawalStatus.REJECTED, [
      WithdrawalStatus.REQUESTED,
      WithdrawalStatus.RISK_REVIEW,
      WithdrawalStatus.APPROVED,
    ]);
  }

  async fail(withdrawalId: string, reason: string) {
    return this.releaseReservation(withdrawalId, reason, WithdrawalStatus.FAILED, [
      WithdrawalStatus.APPROVED,
      WithdrawalStatus.PENDING_MANUAL_BROADCAST,
      WithdrawalStatus.BROADCASTING,
      WithdrawalStatus.BROADCAST,
      WithdrawalStatus.CONFIRMING,
    ]);
  }

  private async releaseReservation(
    withdrawalId: string,
    reason: string,
    terminalStatus: WithdrawalStatus,
    allowedFrom: WithdrawalStatus[],
  ) {
    return this.txRunner.run(async (tx) => {
      const withdrawal = await this.casTransition(tx, withdrawalId, allowedFrom, {
        status: terminalStatus,
        failureReason: reason,
      });

      const reservation = await this.reservations.findActiveByReference(tx, "Withdrawal", withdrawalId);
      if (reservation) {
        await this.reservations.release(tx, reservation.id);
      }

      return withdrawal;
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

  private async getOrThrow(withdrawalId: string, client: Prisma.TransactionClient | PrismaService = this.prisma) {
    const withdrawal = await client.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) {
      throw new NotFoundException("Withdrawal not found");
    }
    return withdrawal;
  }

  /**
   * Atomic compare-and-swap: only succeeds if the row is currently in one
   * of `allowedFrom`. Throws ConflictException (409) on a 0-row result —
   * the caller was not first, whether because of a genuine race or a
   * double-click/retry.
   */
  private async casTransition(
    tx: Prisma.TransactionClient,
    withdrawalId: string,
    allowedFrom: WithdrawalStatus[],
    data: Prisma.WithdrawalUpdateManyMutationInput,
  ): Promise<Withdrawal> {
    const result = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: { in: allowedFrom } },
      data,
    });

    if (result.count === 0) {
      const current = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
      if (!current) {
        throw new NotFoundException("Withdrawal not found");
      }
      throw new ConflictException(
        `Withdrawal ${withdrawalId} is in status ${current.status}, expected one of: ${allowedFrom.join(", ")}`,
      );
    }

    return tx.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  }
}
