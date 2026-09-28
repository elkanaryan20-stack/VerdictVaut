import { Injectable, NotFoundException } from "@nestjs/common";
import { OrderSide, OrderStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MatchCandidate } from "../matching/matching-engine.interface";

export interface OrderBookLevel {
  price: string;
  remainingQuantity: string;
}

export interface OrderBookView {
  marketId: string;
  outcomeId: string;
  /** Highest price first. */
  bids: OrderBookLevel[];
  /** Lowest price first. */
  asks: OrderBookLevel[];
  asOf: string;
}

/**
 * Read model only — aggregates resting LIMIT orders into price levels,
 * never exposing raw Order rows or userIds. This is what a future
 * frontend/matcher reads; it does not mutate anything.
 */
@Injectable()
export class OrderBookService {
  constructor(private readonly prisma: PrismaService) {}

  async getBook(marketId: string, outcomeId: string): Promise<OrderBookView> {
    const outcome = await this.prisma.marketOutcome.findUnique({ where: { id: outcomeId } });
    if (!outcome || outcome.marketId !== marketId) {
      throw new NotFoundException("Outcome does not belong to this market");
    }

    // Phase 38 — aggregated in SQL (one row per side+price level) instead of
    // loading every resting order and summing in JS. Same result; measured
    // p50 181ms at 4,000 resting orders before (test/perf/data-volume.perf-spec.ts),
    // on a PUBLIC, unauthenticated endpoint whose response is only ever the levels.
    const grouped = await this.prisma.order.groupBy({
      by: ["side", "price"],
      where: {
        marketId,
        outcomeId,
        status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] },
        price: { not: null },
      },
      _sum: { remainingQuantity: true },
    });
    const restingLevels = grouped.map((g) => ({ side: g.side, price: g.price, remainingQuantity: g._sum.remainingQuantity ?? new Prisma.Decimal(0) }));

    const bidLevels = aggregateLevels(restingLevels.filter((o) => o.side === OrderSide.BUY));
    const askLevels = aggregateLevels(restingLevels.filter((o) => o.side === OrderSide.SELL));

    return {
      marketId,
      outcomeId,
      bids: sortLevels(bidLevels, "desc"),
      asks: sortLevels(askLevels, "asc"),
      asOf: new Date().toISOString(),
    };
  }

  /**
   * Individual resting orders on one side, for the matching engine — a
   * different shape from getBook() (which aggregates into anonymous price
   * levels and never exposes userId/orderId/sequence). Bounded by the
   * composite index on (marketId, outcomeId, side, status, price,
   * sequence): this is an indexed range scan, not a full-table load, and
   * result size is naturally bounded by how much resting liquidity exists
   * on one side of one outcome. Pre-sorted by price-time priority here as
   * a query-plan optimization; the matching engine re-sorts defensively
   * regardless (it must not trust caller-supplied ordering to be correct).
   *
   * Deliberately no LIMIT: the matching engine must see every crossable
   * resting order to avoid leaving matchable liquidity unswept, so capping
   * this query would trade correctness for performance — not a safe trade.
   * This has been reviewed against the index above and is structurally
   * sound; it has NOT been load-tested against a pathologically deep book
   * (e.g. tens of thousands of resting orders on one side of one outcome).
   * If that ever becomes a realistic production shape, revisit with real
   * order-book depth data (EXPLAIN ANALYZE under that load) rather than
   * guessing at a cap now — tracked as a future performance task, not a
   * known defect.
   */
  /**
   * `crossingBound` (Phase 38, optional) restricts the load to orders that
   * can actually cross — both matching engines sort by price-time priority
   * and stop at the first non-crossing price, so rows beyond the bound are
   * never used. Without it, every incoming order loaded the ENTIRE opposite
   * side of the book (measured: p50 220ms at 4,000 resting orders), and
   * that cost now sits inside the per-market execution queue.
   */
  async getRestingCandidates(
    marketId: string,
    outcomeId: string,
    side: OrderSide,
    crossingBound?: { gte?: Prisma.Decimal; lte?: Prisma.Decimal },
  ): Promise<MatchCandidate[]> {
    const orders = await this.prisma.order.findMany({
      where: {
        marketId,
        outcomeId,
        side,
        status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] },
        price: crossingBound ? { not: null, ...crossingBound } : { not: null },
      },
      select: { id: true, userId: true, side: true, price: true, remainingQuantity: true, sequence: true },
      orderBy: [{ price: side === OrderSide.SELL ? "asc" : "desc" }, { sequence: "asc" }],
    });

    return orders.map((o) => ({
      orderId: o.id,
      userId: o.userId,
      side: o.side,
      price: o.price!,
      remainingQuantity: o.remainingQuantity,
      sequence: o.sequence,
    }));
  }
}

function aggregateLevels(orders: { price: Prisma.Decimal | null; remainingQuantity: Prisma.Decimal }[]) {
  const levels = new Map<string, Prisma.Decimal>();
  for (const order of orders) {
    if (!order.price) continue;
    const key = order.price.toString();
    levels.set(key, (levels.get(key) ?? new Prisma.Decimal(0)).plus(order.remainingQuantity));
  }
  return levels;
}

function sortLevels(levels: Map<string, Prisma.Decimal>, direction: "asc" | "desc"): OrderBookLevel[] {
  return [...levels.entries()]
    .map(([price, remainingQuantity]) => ({ price, remainingQuantity: remainingQuantity.toString() }))
    .sort((a, b) => {
      const cmp = new Prisma.Decimal(a.price).comparedTo(new Prisma.Decimal(b.price));
      return direction === "asc" ? cmp : -cmp;
    });
}
