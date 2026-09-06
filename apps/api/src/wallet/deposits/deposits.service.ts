import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Deposit, DepositStatus, Prisma } from "@prisma/client";
import { AuditLogService } from "../../audit/audit-log.service";
import { LedgerService } from "../../ledger/ledger.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

type DepositWithAssetNetwork = Deposit & {
  assetNetwork: Prisma.AssetNetworkGetPayload<{ include: { asset: true; network: true } }>;
};

export interface PaginatedDeposits {
  items: DepositWithAssetNetwork[];
  total: number;
  page: number;
  pageSize: number;
}

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
  /**
   * Destination tag/memo the chain actually reported on this transaction
   * (XRP and similar tag-addressed chains) — omitted, never fabricated,
   * when the chain didn't carry one. Always persisted verbatim (see
   * Deposit.destinationTag) regardless of whether it turns out valid.
   */
  destinationTag?: string;
  rawProviderPayload?: Record<string, unknown>;
}

/**
 * This is the crediting path a real chain watcher/reconciliation job
 * calls once it has observed an actual transaction on-chain (see
 * DepositWatcherService and DepositReprocessingService) — it is never
 * invoked from a user- or frontend-facing endpoint, because a deposit
 * must never be credited "because the frontend said so".
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

    const { deposit, justCredited, justFailed } = await this.txRunner.run(async (tx) => {
      const isConfirmed = input.confirmations >= input.requiredConfirmations;
      const assetNetwork = await tx.assetNetwork.findUniqueOrThrow({ where: { id: input.assetNetworkId } });
      const walletAddress = await tx.walletAddress.findUniqueOrThrow({ where: { id: input.walletAddressId } });

      // XRP (and any other tag/memo-addressed chain): never credit a
      // deposit to this address's owner on address match alone when a
      // tag is configured as required — the observed tag must actually
      // match the one this address was provisioned with.
      const tagValid =
        !assetNetwork.memoRequired || (input.destinationTag != null && input.destinationTag === walletAddress.destinationTag);
      const failureReason = tagValid
        ? null
        : `Destination tag mismatch: observed ${input.destinationTag ?? "(none)"}, expected ${walletAddress.destinationTag ?? "(none)"}`;

      const now = new Date();
      // Captured before the upsert specifically so justFailed (below) can
      // tell "this call is the one that first made it FAILED" apart from
      // "it was already FAILED" — Prisma's upsert return value alone
      // can't distinguish those for a row created directly as FAILED.
      const previousStatus = (
        await tx.deposit.findUnique({
          where: { assetNetworkId_txHash_eventIndex: { assetNetworkId: input.assetNetworkId, txHash: input.txHash, eventIndex } },
          select: { status: true },
        })
      )?.status;

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
          status: !tagValid ? DepositStatus.FAILED : isConfirmed ? DepositStatus.CONFIRMED : DepositStatus.PENDING,
          destinationTag: input.destinationTag ?? null,
          failureReason,
          rawProviderPayload: input.rawProviderPayload as Prisma.InputJsonValue,
          confirmedAt: tagValid && isConfirmed ? now : null,
          lastCheckedAt: now,
        },
        // Deliberately does not touch `status` here — a late-arriving or
        // duplicate watcher update must never regress a deposit that has
        // already reached CONFIRMED/CREDITED back to an earlier status.
        // The guarded updateMany calls below are the only place a
        // pre-existing row's status ever changes.
        update: {
          confirmations: input.confirmations,
          rawProviderPayload: input.rawProviderPayload as Prisma.InputJsonValue,
          destinationTag: input.destinationTag ?? undefined,
          lastCheckedAt: now,
        },
      });

      if (!tagValid) {
        await tx.deposit.updateMany({
          where: { id: upserted.id, status: { in: [DepositStatus.PENDING, DepositStatus.CONFIRMED] } },
          data: { status: DepositStatus.FAILED, failureReason },
        });
      } else if (isConfirmed && upserted.status === DepositStatus.PENDING) {
        await tx.deposit.updateMany({
          where: { id: upserted.id, status: DepositStatus.PENDING },
          data: { status: DepositStatus.CONFIRMED, confirmedAt: now },
        });
      }

      let justCredited = false;
      if (isConfirmed && tagValid) {
        justCredited = await this.creditDeposit(tx, upserted.id, upserted.userId, upserted.amount, input.assetSymbol);
      }

      return {
        deposit: await tx.deposit.findUniqueOrThrow({ where: { id: upserted.id } }),
        justCredited,
        justFailed: !tagValid && previousStatus !== DepositStatus.FAILED,
      };
    });

    if (justFailed) {
      await this.auditLog.record({
        actorType: "SYSTEM",
        action: "deposit.tag_mismatch",
        resourceType: "Deposit",
        resourceId: deposit.id,
        after: { status: deposit.status, failureReason: deposit.failureReason },
        reason: deposit.failureReason ?? undefined,
        idempotencyKey: `deposit:${deposit.id}:tag_mismatch`,
      });
    }

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
    const { transactionId, alreadyPosted } = await this.ledger.postTransaction(tx, {
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
      data: { status: DepositStatus.CREDITED, creditedAt: new Date(), ledgerTransactionId: transactionId },
    });

    if (alreadyPosted) {
      this.logger.debug(`Deposit ${depositId} was already credited — idempotent no-op.`);
      return false;
    }

    this.logger.log(`Deposit ${depositId} credited to user ${userId} (${amount.toString()} ${assetSymbol}).`);
    return statusUpdate.count > 0;
  }

  /**
   * Marks a not-yet-credited deposit as chain-invalidated (a reorg
   * dropped it, or a reprocess found it no longer exists on chain) — a
   * terminal, economically-inert outcome distinct from FAILED. Never
   * touches a CREDITED row: once real funds have moved, this is not the
   * mechanism to undo that (see requirement #13 — an unsafe automatic
   * reversal after credit is an explicit, documented blocker, not
   * something this method silently attempts).
   */
  async rejectIfNotCredited(depositId: string, reason: string): Promise<{ deposit: Deposit; justRejected: boolean }> {
    return this.txRunner.run(async (tx) => {
      const result = await tx.deposit.updateMany({
        where: { id: depositId, status: { in: [DepositStatus.PENDING, DepositStatus.CONFIRMED] } },
        data: { status: DepositStatus.REJECTED, failureReason: reason, lastCheckedAt: new Date() },
      });
      const deposit = await tx.deposit.findUniqueOrThrow({ where: { id: depositId } });
      return { deposit, justRejected: result.count > 0 };
    });
  }

  async touchLastChecked(depositId: string): Promise<void> {
    await this.prisma.deposit.update({ where: { id: depositId }, data: { lastCheckedAt: new Date(), retryCount: { increment: 1 } } });
  }

  /**
   * Paginated — a user's deposit history is unbounded over time, and
   * loading it in full into a browser tab would only get worse the
   * longer an account has existed. `page` is clamped to >= 1 and
   * `pageSize` to [1, MAX_PAGE_SIZE] so a malformed or hostile query
   * param can't force an unbounded scan.
   */
  async listMine(userId: string, page = 1, pageSize = DEFAULT_PAGE_SIZE): Promise<PaginatedDeposits> {
    const safePage = Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1;
    const requestedPageSize = Number.isFinite(pageSize) && pageSize >= 1 ? Math.trunc(pageSize) : DEFAULT_PAGE_SIZE;
    const safePageSize = Math.min(MAX_PAGE_SIZE, requestedPageSize);

    const [items, total] = await Promise.all([
      this.prisma.deposit.findMany({
        where: { userId },
        orderBy: { detectedAt: "desc" },
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
        include: { assetNetwork: { include: { asset: true, network: true } } },
      }),
      this.prisma.deposit.count({ where: { userId } }),
    ]);

    return { items, total, page: safePage, pageSize: safePageSize };
  }

  async getOwned(userId: string, depositId: string) {
    const deposit = await this.prisma.deposit.findUnique({
      where: { id: depositId },
      include: { assetNetwork: { include: { asset: true, network: true } } },
    });
    if (!deposit || deposit.userId !== userId) {
      throw new NotFoundException("Deposit not found");
    }
    return deposit;
  }

  async getById(depositId: string) {
    const deposit = await this.prisma.deposit.findUnique({
      where: { id: depositId },
      include: {
        user: { select: { id: true, email: true } },
        assetNetwork: { include: { asset: true, network: true } },
        walletAddress: true,
      },
    });
    if (!deposit) {
      throw new NotFoundException("Deposit not found");
    }
    return deposit;
  }

  async listAll() {
    return this.prisma.deposit.findMany({
      orderBy: { detectedAt: "desc" },
      include: { user: { select: { id: true, email: true } }, assetNetwork: { include: { asset: true, network: true } } },
    });
  }

  /** Deposits that have sat unresolved for a while — the "discoverable" half of requirement #20 (observability). */
  async listStale(olderThanMs: number) {
    return this.prisma.deposit.findMany({
      where: {
        status: { in: [DepositStatus.PENDING, DepositStatus.CONFIRMED, DepositStatus.FAILED] },
        OR: [{ lastCheckedAt: { lt: new Date(Date.now() - olderThanMs) } }, { lastCheckedAt: null }],
      },
      orderBy: { detectedAt: "asc" },
    });
  }
}
