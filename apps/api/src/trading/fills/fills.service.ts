import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface FillView {
  fillId: string;
  marketId: string;
  outcomeId: string;
  orderId: string;
  side: "BUY" | "SELL";
  isMaker: boolean;
  price: string;
  quantity: string;
  fee: string;
  executedAt: string;
}

export interface PaginatedFills {
  items: FillView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Read-only, own-executions-only. A Fill row also carries the
 * counterparty's userId/orderId (buyerUserId/sellerUserId,
 * makerOrderId/takerOrderId) — toView() below deliberately projects only
 * the caller's own side of the trade (their own order id, their own
 * BUY/SELL direction, whether they were maker or taker) and never
 * forwards the other party's identity or order id, matching the same
 * projection OrdersService.getPlacementSummary already applies.
 */
@Injectable()
export class FillsService {
  constructor(private readonly prisma: PrismaService) {}

  async listMine(userId: string, options: { page?: number; pageSize?: number; marketId?: string } = {}): Promise<PaginatedFills> {
    const safePage = Number.isFinite(options.page) && (options.page as number) >= 1 ? Math.trunc(options.page as number) : 1;
    const requestedPageSize =
      Number.isFinite(options.pageSize) && (options.pageSize as number) >= 1 ? Math.trunc(options.pageSize as number) : DEFAULT_PAGE_SIZE;
    const safePageSize = Math.min(MAX_PAGE_SIZE, requestedPageSize);

    const where = {
      OR: [{ buyerUserId: userId }, { sellerUserId: userId }],
      ...(options.marketId ? { marketId: options.marketId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.fill.findMany({
        where,
        orderBy: { executedAt: "desc" },
        skip: (safePage - 1) * safePageSize,
        take: safePageSize,
      }),
      this.prisma.fill.count({ where }),
    ]);

    return { items: rows.map((fill) => this.toView(userId, fill)), total, page: safePage, pageSize: safePageSize };
  }

  private toView(
    userId: string,
    fill: {
      id: string;
      marketId: string;
      outcomeId: string;
      buyOrderId: string;
      sellOrderId: string;
      makerOrderId: string;
      takerOrderId: string;
      buyerUserId: string;
      price: { toString(): string };
      quantity: { toString(): string };
      fee: { toString(): string };
      executedAt: Date;
    },
  ): FillView {
    const isBuyer = fill.buyerUserId === userId;
    const orderId = isBuyer ? fill.buyOrderId : fill.sellOrderId;
    return {
      fillId: fill.id,
      marketId: fill.marketId,
      outcomeId: fill.outcomeId,
      orderId,
      side: isBuyer ? "BUY" : "SELL",
      isMaker: orderId === fill.makerOrderId,
      price: fill.price.toString(),
      quantity: fill.quantity.toString(),
      fee: fill.fee.toString(),
      executedAt: fill.executedAt.toISOString(),
    };
  }
}
