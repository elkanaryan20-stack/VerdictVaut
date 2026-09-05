import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { MarketStatus, Prisma } from "@prisma/client";
import { LedgerService } from "../ledger/ledger.service";
import { createIdempotent } from "../prisma/idempotent-create.util";
import { PrismaService } from "../prisma/prisma.service";
import { SerializableTransactionRunner } from "../prisma/serializable-transaction-runner";
import { computeSettlementPayout } from "./payout.util";

export interface SettleMarketResult {
  /** Positions this call actually settled (0 on a pure retry that finds nothing left to do). */
  settledCount: number;
  /** Positions still unsettled for this market after this call — 0 means fully paid out. */
  remaining: number;
  /** True once the market has reached RESOLVED (remaining === 0 and the final CAS succeeded, here or by a concurrent caller). */
  resolved: boolean;
}

/**
 * Turns a recorded MarketResolution + its per-outcome Settlement rate
 * rows into real, atomic, ledger-authoritative payouts — one position at
 * a time. This is the ONLY place that posts settlement ledger entries,
 * creates PositionSettlement rows, or stamps Position.settledAt. Never
 * hidden inside PositionsService/OrdersService (see the module docblock
 * on where this sits architecturally).
 *
 * Mirrors ExecutionCoordinator's shape exactly: candidate discovery
 * (which positions are unsettled) happens outside any transaction — it
 * is advisory only — and each position is settled in its OWN dedicated
 * SERIALIZABLE transaction that re-fetches and re-validates that
 * position's CURRENT state before doing anything. This is what makes a
 * stale/concurrent view of "which positions still need settling" safe:
 * a position already settled by a concurrent call is simply skipped, not
 * double-paid. No instruction here is ever retried blindly — a failure
 * partway through just leaves `remaining` above zero for a future call
 * (settleMarket / ResolutionService.retrySettlement) to pick up, exactly
 * where it left off; positions that DID settle before the failure stay
 * settled.
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: SerializableTransactionRunner,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Idempotent and resumable: safe to call repeatedly (sequentially or
   * concurrently) for the same market, including after a prior call
   * failed partway through, or after the market has already fully
   * resolved (a harmless no-op in that case). Settles every currently
   * UNSETTLED position for this market, then — only if none remain —
   * flips the market RESOLVING -> RESOLVED.
   */
  async settleMarket(marketId: string): Promise<SettleMarketResult> {
    const market = await this.prisma.market.findUniqueOrThrow({ where: { id: marketId } });
    if (market.status === MarketStatus.RESOLVED) {
      return { settledCount: 0, remaining: 0, resolved: true };
    }
    if (market.status !== MarketStatus.RESOLVING) {
      throw new BadRequestException(
        `Market ${marketId} is not awaiting settlement (status=${market.status}) — resolve it first`,
      );
    }

    // Advisory snapshot only — bounded by real participation in this one
    // market (see the index on Position(marketId, settledAt)), not a
    // full-table scan. Each id is re-validated fresh inside its own
    // transaction below; this list is never trusted as still-accurate.
    const unsettled = await this.prisma.position.findMany({
      where: { marketId, settledAt: null },
      select: { id: true },
    });

    let settledCount = 0;
    for (const { id } of unsettled) {
      const didSettle = await this.settleOnePosition(id);
      if (didSettle) settledCount += 1;
    }

    const remaining = await this.prisma.position.count({ where: { marketId, settledAt: null } });
    let resolved = false;
    if (remaining === 0) {
      resolved = await this.finalizeResolved(marketId);
    }

    this.logger.log(`Settlement pass for market ${marketId}`, { settledCount, remaining, resolved });
    return { settledCount, remaining, resolved };
  }

  /**
   * Settles exactly one position, or safely does nothing. Returns false
   * when the position was already settled by a concurrent/prior call —
   * an expected outcome under concurrency, not an error.
   */
  private async settleOnePosition(positionId: string): Promise<boolean> {
    return this.txRunner.run(async (tx) => {
      const position = await tx.position.findUniqueOrThrow({ where: { id: positionId } });
      if (position.settledAt) {
        return false; // a concurrent settlement pass already handled this one
      }

      // Structural invariant established by MarketsService.close(): every
      // resting order (and therefore every reservation) for this market
      // was released before it could ever reach CLOSED, the precondition
      // for resolution. If this ever fails, something upstream is
      // broken — throw loudly rather than settle against a position that
      // still has an outstanding claim against it.
      if (!position.reservedQuantity.isZero()) {
        throw new Error(
          `Position ${position.id} still has an active reservation (${position.reservedQuantity.toString()}) ` +
            `— market close must release all reservations before settlement can proceed`,
        );
      }

      const rate = await tx.settlement.findUniqueOrThrow({
        where: { marketId_outcomeId: { marketId: position.marketId, outcomeId: position.outcomeId } },
      });
      const payoutAmount = computeSettlementPayout(position.quantity, rate.payoutPerShare);

      // Posted BEFORE the PositionSettlement row is created — never
      // after — so that row is always inserted with its ledgerTransactionId
      // already correct (null iff payoutAmount is zero), never in a
      // transiently-inconsistent state; the DB CHECK constraint
      // (position_settlements_ledger_ref_consistency_check) enforces this
      // invariant on every single row version, including the very first
      // insert, not just the final one. Keyed off positionId (not the
      // not-yet-created settlement row's id) so it's derivable up front
      // and stays idempotent across retries the same way everything else
      // in this transaction is.
      let ledgerTransactionId: string | null = null;
      if (!payoutAmount.isZero()) {
        const settlementAsset = await tx.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } });
        const { transactionId } = await this.ledger.postTransaction(tx, {
          assetSymbol: settlementAsset.symbol,
          type: "SETTLEMENT",
          referenceType: "Position",
          referenceId: position.id,
          idempotencyKey: `settlement-payout:${position.id}`,
          postings: [
            { account: { type: "USER", userId: position.userId }, amount: payoutAmount },
            { account: { type: "HOUSE", key: "SETTLEMENT_POOL" }, amount: payoutAmount.negated() },
          ],
        });
        ledgerTransactionId = transactionId;
      }

      const idempotencyKey = `settlement:${position.id}`;
      const { alreadyExisted } = await createIdempotent(
        tx,
        "idempotencyKey",
        () =>
          tx.positionSettlement.create({
            data: {
              positionId: position.id,
              marketId: position.marketId,
              outcomeId: position.outcomeId,
              userId: position.userId,
              quantity: position.quantity,
              payoutPerShare: rate.payoutPerShare,
              payoutAmount,
              ledgerTransactionId,
              idempotencyKey,
            },
          }),
        () => tx.positionSettlement.findUniqueOrThrow({ where: { idempotencyKey } }),
      );
      if (alreadyExisted) {
        return false; // a concurrent pass already fully committed this position's settlement
      }

      const stamped = await tx.position.updateMany({
        where: { id: position.id, settledAt: null },
        data: { settledAt: new Date() },
      });
      if (stamped.count === 0) {
        // Should be unreachable under SERIALIZABLE (a concurrent writer
        // would instead abort this whole transaction) — defensive
        // backstop only, same idiom as ExecutionCoordinator.updateOrders.
        throw new Error(`Position ${position.id} changed unexpectedly mid-settlement`);
      }

      return true;
    });
  }

  /**
   * A single user's own settlement results for one market — read-only,
   * no side effects. Used by MarketsController's per-user endpoint so
   * individual payout amounts are never exposed through the aggregate
   * (public) resolution-status endpoint.
   */
  async getUserSettlements(userId: string, marketId: string) {
    return this.prisma.positionSettlement.findMany({
      where: { userId, marketId },
      include: { outcome: { select: { id: true, key: true, label: true } } },
      orderBy: { settledAt: "asc" },
    });
  }

  /**
   * CAS RESOLVING -> RESOLVED, tolerant of a concurrent caller having
   * already won it (harmless no-op — `remaining === 0` is true either
   * way, which is all the caller needs to know).
   */
  private async finalizeResolved(marketId: string): Promise<boolean> {
    return this.txRunner.run(async (tx) => {
      await tx.market.updateMany({
        where: { id: marketId, status: MarketStatus.RESOLVING },
        data: { status: MarketStatus.RESOLVED },
      });
      // Regardless of whether THIS call's CAS won, set settledAt exactly
      // once — guarded the same way, so a race here is also a no-op.
      await tx.marketResolution.updateMany({
        where: { marketId, settledAt: null },
        data: { settledAt: new Date() },
      });
      const refreshed = await tx.market.findUniqueOrThrow({ where: { id: marketId } });
      return refreshed.status === MarketStatus.RESOLVED;
    });
  }
}
