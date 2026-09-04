import { Injectable, Logger } from "@nestjs/common";
import { DepositStatus, Prisma } from "@prisma/client";
import { AuditLogService } from "../../audit/audit-log.service";
import { LedgerService } from "../../ledger/ledger.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";

export interface ObservedTransactionInput {
  userId: string;
  assetSymbol: string;
  assetNetworkId: string;
  walletAddressId: string;
  txHash: string;
  /**
   * Disambiguates multiple deposit events within one on-chain transaction
   * (e.g. an EVM token Transfer log's index). Defaults to 0 for chains
   * where a transaction maps to exactly one event. txHash alone is NOT a
   * safe identity for token transfers — see the Deposit model comment.
   */
  eventIndex?: number;
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
 *
 * Idempotency: `recordObservedTransaction` may be called any number of
 * times for the same (assetNetworkId, txHash, eventIndex) — duplicate
 * watcher runs, retried webhooks, reprocessing after a crash — and it
 * will credit the user's ledger account exactly once. That guarantee
 * comes from two independent layers: the DB-level unique constraint on
 * (assetNetworkId, txHash, eventIndex) for the Deposit row itself, and
 * the unique constraint on `ledger_transactions.idempotencyKey`
 * (`deposit:<depositId>`) for the credit — not from this method's own
 * control flow — so it holds even under true concurrent execution, not
 * just sequential retries.
 */
@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly txRunner: SerializableTransactionRunner,
    private readonly auditLog: AuditLogService,
  ) {}

  async recordObservedTransaction(input: ObservedTransactionInput) {
    const eventIndex = input.eventIndex ?? 0;

    const { deposit, justCredited } = await this.txRunner.run(async (tx) => {
      const isConfirmed = input.confirmations >= input.requiredConfirmations;
      const assetNetwork = await tx.assetNetwork.findUniqueOrThrow({ where: { id: input.assetNetworkId } });

      const upserted = await tx.deposit.upsert({
        where: {
          assetNetworkId_txHash_eventIndex: {
            assetNetworkId: input.assetNetworkId,
            txHash: input.txHash,
            eventIndex,
          },
        },
        create: {
          userId: input.userId,
          assetId: assetNetwork.assetId,
          assetNetworkId: input.assetNetworkId,
          walletAddressId: input.walletAddressId,
          txHash: input.txHash,
          eventIndex,
          amount: new Prisma.Decimal(input.amount),
          confirmations: input.confirmations,
          requiredConfirmations: input.requiredConfirmations,
          status: isConfirmed ? DepositStatus.CONFIRMED : DepositStatus.PENDING,
          rawProviderPayload: input.rawProviderPayload as Prisma.InputJsonValue,
          confirmedAt: isConfirmed ? new Date() : null,
        },
        // Deliberately does not touch `status` here — a late-arriving or
        // duplicate watcher update must never regress a deposit that has
        // already reached CONFIRMED/CREDITED back to an earlier status.
        update: {
          confirmations: input.confirmations,
          rawProviderPayload: input.rawProviderPayload as Prisma.InputJsonValue,
        },
      });

      if (isConfirmed && upserted.status === DepositStatus.PENDING) {
        await tx.deposit.updateMany({
          where: { id: upserted.id, status: DepositStatus.PENDING },
          data: { status: DepositStatus.CONFIRMED, confirmedAt: new Date() },
        });
      }

      let justCredited = false;
      if (isConfirmed) {
        justCredited = await this.creditDeposit(tx, upserted.id, upserted.userId, upserted.amount, input.assetSymbol);
      }

      return { deposit: await tx.deposit.findUniqueOrThrow({ where: { id: upserted.id } }), justCredited };
    });

    if (justCredited) {
      await this.auditLog.record({
        actorType: "SYSTEM",
        action: "deposit.credit",
        resourceType: "Deposit",
        resourceId: deposit.id,
        before: { status: "CONFIRMED" },
        after: { status: deposit.status, amount: deposit.amount.toString() },
        idempotencyKey: `deposit:${deposit.id}`,
      });
    }

    return deposit;
  }

  /** Returns true only if this call is the one that actually posted the credit (not an idempotent replay). */
  private async creditDeposit(
    tx: Prisma.TransactionClient,
    depositId: string,
    userId: string,
    amount: Prisma.Decimal,
    assetSymbol: string,
  ): Promise<boolean> {
    const { alreadyPosted } = await this.ledger.postTransaction(tx, {
      assetSymbol,
      type: "DEPOSIT",
      referenceType: "Deposit",
      referenceId: depositId,
      idempotencyKey: `deposit:${depositId}`,
      postings: [
        { account: { type: "USER", userId }, amount },
        { account: { type: "HOUSE", key: "EXTERNAL_CHAIN" }, amount: amount.negated() },
      ],
    });

    // Guarded regardless of `alreadyPosted` — cheap, and makes this method
    // safe to call repeatedly even if the status update from a previous
    // attempt somehow didn't commit (e.g. a crash between the two).
    const statusUpdate = await tx.deposit.updateMany({
      where: { id: depositId, status: { not: DepositStatus.CREDITED } },
      data: { status: DepositStatus.CREDITED, creditedAt: new Date() },
    });

    if (alreadyPosted) {
      this.logger.debug(`Deposit ${depositId} was already credited — idempotent no-op.`);
      return false;
    }

    this.logger.log(`Deposit ${depositId} credited to user ${userId} (${amount.toString()} ${assetSymbol}).`);
    return statusUpdate.count > 0;
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
