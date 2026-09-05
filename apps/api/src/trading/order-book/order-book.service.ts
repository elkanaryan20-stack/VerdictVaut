import { Injectable, NotFoundException } from "@nestjs/common";
import { OrderSide, OrderStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

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

    const restingOrders = await this.prisma.order.findMany({
      where: {
        marketId,
        outcomeId,
        status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] },
        price: { not: null },
      },
      select: { side: true, price: true, remainingQuantity: true },
    });

    const bidLevels = aggregateLevels(restingOrders.filter((o) => o.side === OrderSide.BUY));
    const askLevels = aggregateLevels(restingOrders.filter((o) => o.side === OrderSide.SELL));

    return {
      marketId,
      outcomeId,
      bids: sortLevels(bidLevels, "desc"),
      asks: sortLevels(askLevels, "asc"),
      asOf: new Date().toISOString(),
    };
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
