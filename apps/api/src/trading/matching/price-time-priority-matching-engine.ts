import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ExecutionInstruction, MatchCandidate, MatchingEngine } from "./matching-engine.interface";

/**
 * Self-trade policy: REJECT_SELF_TRADE. A user's own resting order is
 * filtered out of the opposite-side candidate list before any price/time
 * comparison happens — the incoming order simply cannot see its own
 * resting orders as counterparties. It is never matched, never cancelled,
 * never expired by this engine; it just continues resting untouched,
 * available to match against everyone else. This is a deliberate, narrow
 * choice over "cancel/expire the resting order": expiring someone's
 * resting liquidity as a side effect of an unrelated order crossing would
 * be a surprising, hard-to-reason-about interaction for a policy this
 * engine has no business making unilaterally.
 */
@Injectable()
export class PriceTimePriorityMatchingEngine implements MatchingEngine {
  match(
    marketId: string,
    outcomeId: string,
    incoming: MatchCandidate,
    restingOpposite: MatchCandidate[],
  ): ExecutionInstruction[] {
    const eligible = restingOpposite
      .filter((resting) => resting.side !== incoming.side)
      .filter((resting) => resting.userId !== incoming.userId)
      .sort((a, b) => comparePriority(incoming, a, b));

    const instructions: ExecutionInstruction[] = [];
    let remaining = incoming.remainingQuantity;

    for (const resting of eligible) {
      if (remaining.lessThanOrEqualTo(0)) break;
      if (resting.remainingQuantity.lessThanOrEqualTo(0)) continue;

      const crosses =
        incoming.side === "BUY"
          ? incoming.price.greaterThanOrEqualTo(resting.price)
          : incoming.price.lessThanOrEqualTo(resting.price);

      // Sorted best-price-first: once one resting order fails to cross,
      // every later one (strictly worse-priced) fails too.
      if (!crosses) break;

      const executionQuantity = Prisma.Decimal.min(remaining, resting.remainingQuantity);
      // Execution price is always the RESTING (maker) order's price — the
      // resting order has price priority; the incoming order never gets a
      // worse fill than its own limit, and any gap between the two limit
      // prices is the incoming side's price improvement, never destroyed.
      const executionPrice = resting.price;

      const isIncomingBuy = incoming.side === "BUY";
      const buyOrderId = isIncomingBuy ? incoming.orderId : resting.orderId;
      const sellOrderId = isIncomingBuy ? resting.orderId : incoming.orderId;
      const buyerUserId = isIncomingBuy ? incoming.userId : resting.userId;
      const sellerUserId = isIncomingBuy ? resting.userId : incoming.userId;

      instructions.push({
        // Deterministic from the (maker, taker) order-identity pair alone:
        // regenerating this instruction from a fresher snapshot (e.g. after
        // a stale-instruction rejection) reproduces the exact same key, so
        // the DB's unique constraint on Fill.idempotencyKey is what
        // actually prevents a double-apply — not this key being "new"
        // each time.
        idempotencyKey: `fill:${resting.orderId}:${incoming.orderId}`,
        marketId,
        outcomeId,
        buyOrderId,
        sellOrderId,
        makerOrderId: resting.orderId,
        takerOrderId: incoming.orderId,
        buyerUserId,
        sellerUserId,
        price: executionPrice.toString(),
        quantity: executionQuantity.toString(),
      });

      remaining = remaining.minus(executionQuantity);
    }

    return instructions;
  }
}

function comparePriority(incoming: MatchCandidate, a: MatchCandidate, b: MatchCandidate): number {
  // Best price first: for an incoming BUY, opposite side is asks — lowest
  // price first. For an incoming SELL, opposite side is bids — highest
  // price first.
  const priceCmp = incoming.side === "BUY" ? a.price.comparedTo(b.price) : b.price.comparedTo(a.price);
  if (priceCmp !== 0) return priceCmp;
  // Same price: earliest sequence (FIFO) wins — never reversed.
  if (a.sequence < b.sequence) return -1;
  if (a.sequence > b.sequence) return 1;
  return 0;
}
