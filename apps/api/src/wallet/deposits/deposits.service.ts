import { Injectable, Logger } from "@nestjs/common";
import { DepositStatus, LedgerEntryType, Prisma } from "@prisma/client";
import { LedgerService } from "../../ledger/ledger.service";
import { PrismaService } from "../../prisma/prisma.service";

export interface ObservedTransactionInput {
  userId: string;
  assetSymbol: string;
  assetNetworkId: string;
  walletAddressId: string;
  txHash: string;
  amount: string;
  confirmations: number;
  requiredConfirmations: number;
  rawProviderPayload?: Record<string, unknown>;
}

/**
 * This is the crediting path a real chain watcher/reconciliation job
 * calls once it has observed an actual transaction on-chain — it is
 * never invoked from a user- or frontend-facing endpoint, because a
 * deposit must never be credited "because the frontend said so".
 *
 * No chain watcher is wired up yet (that requires a real RPC/provider
 * integration per network, deliberately left for the next phase), so
 * this method currently has no caller in the running app — it exists so
 * the crediting transaction boundary is defined, correct, and testable
 * ahead of that integration.
 */
@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async recordObservedTransaction(input: ObservedTransactionInput) {
    const isConfirmed = input.confirmations >= input.requiredConfirmations;

    const deposit = await this.prisma.deposit.upsert({
      where: { assetNetworkId_txHash: { assetNetworkId: input.assetNetworkId, txHash: input.txHash } },
      create: {
        userId: input.userId,
        assetId: (await this.prisma.assetNetwork.findUniqueOrThrow({ where: { id: input.assetNetworkId } })).assetId,
        assetNetworkId: input.assetNetworkId,
        walletAddressId: input.walletAddressId,
        txHash: input.txHash,
        amount: new Prisma.Decimal(input.amount),
        confirmations: input.confirmations,
        requiredConfirmations: input.requiredConfirmations,
        status: isConfirmed ? DepositStatus.CONFIRMED : DepositStatus.PENDING,
        rawProviderPayload: input.rawProviderPayload as Prisma.InputJsonValue,
        confirmedAt: isConfirmed ? new Date() : null,
      },
      update: {
        confirmations: input.confirmations,
        status: isConfirmed ? DepositStatus.CONFIRMED : DepositStatus.PENDING,
        rawProviderPayload: input.rawProviderPayload as Prisma.InputJsonValue,
        confirmedAt: isConfirmed ? new Date() : undefined,
      },
    });

    if (isConfirmed && deposit.status !== DepositStatus.CREDITED) {
      await this.creditDeposit(deposit.id, input.assetSymbol);
    }

    return deposit;
  }

  private async creditDeposit(depositId: string, assetSymbol: string) {
    const deposit = await this.prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
    if (deposit.status === DepositStatus.CREDITED) {
      return deposit;
    }

    await this.ledger.postEntry({
      userId: deposit.userId,
      assetSymbol,
      amount: deposit.amount,
      type: LedgerEntryType.DEPOSIT,
      referenceType: "Deposit",
      referenceId: deposit.id,
    });

    const credited = await this.prisma.deposit.update({
      where: { id: depositId },
      data: { status: DepositStatus.CREDITED, creditedAt: new Date() },
    });

    this.logger.log(`Deposit ${depositId} credited to user ${deposit.userId} (${deposit.amount} ${assetSymbol}).`);
    return credited;
  }

  async listMine(userId: string) {
    return this.prisma.deposit.findMany({ where: { userId }, orderBy: { detectedAt: "desc" } });
  }

  async listAll() {
    return this.prisma.deposit.findMany({
      orderBy: { detectedAt: "desc" },
      include: { user: { select: { id: true, email: true } }, assetNetwork: { include: { asset: true, network: true } } },
    });
  }
}
