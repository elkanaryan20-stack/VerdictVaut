import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { OrderBookService } from "./order-book.service";

type Row = { side: "BUY" | "SELL"; price: Prisma.Decimal; remainingQuantity: Prisma.Decimal };

describe("OrderBookService", () => {
  let service: OrderBookService;
  let prisma: { marketOutcome: { findUnique: jest.Mock }; order: { findMany: jest.Mock; groupBy: jest.Mock } };

  /**
   * Phase 38 — getBook now aggregates in SQL (groupBy side+price). The mock
   * performs the same GROUP BY over the given resting rows, so these tests
   * keep asserting the book's behaviour, not the query shape.
   */
  function restingOrders(rows: Row[]) {
    prisma.order.groupBy.mockImplementation(async () => {
      const groups = new Map<string, { side: Row["side"]; price: Prisma.Decimal; _sum: { remainingQuantity: Prisma.Decimal } }>();
      for (const r of rows) {
        const key = `${r.side}:${r.price.toString()}`;
        const existing = groups.get(key);
        if (existing) existing._sum.remainingQuantity = existing._sum.remainingQuantity.plus(r.remainingQuantity);
        else groups.set(key, { side: r.side, price: r.price, _sum: { remainingQuantity: r.remainingQuantity } });
      }
      return [...groups.values()];
    });
  }

  beforeEach(() => {
    prisma = {
      marketOutcome: { findUnique: jest.fn().mockResolvedValue({ id: "outcome-1", marketId: "market-1" }) },
      order: { findMany: jest.fn().mockResolvedValue([]), groupBy: jest.fn().mockResolvedValue([]) },
    };
    service = new OrderBookService(prisma as unknown as PrismaService);
  });

  it("rejects an outcome that does not belong to the market", async () => {
    prisma.marketOutcome.findUnique.mockResolvedValue({ id: "outcome-1", marketId: "other-market" });
    await expect(service.getBook("market-1", "outcome-1")).rejects.toThrow(NotFoundException);
  });

  it("sorts bids highest price first", async () => {
    restingOrders([
      { side: "BUY", price: new Prisma.Decimal("0.3"), remainingQuantity: new Prisma.Decimal("10") },
      { side: "BUY", price: new Prisma.Decimal("0.7"), remainingQuantity: new Prisma.Decimal("5") },
      { side: "BUY", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("2") },
    ]);

    const book = await service.getBook("market-1", "outcome-1");
    expect(book.bids.map((b) => b.price)).toEqual(["0.7", "0.5", "0.3"]);
  });

  it("sorts asks lowest price first", async () => {
    restingOrders([
      { side: "SELL", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10") },
      { side: "SELL", price: new Prisma.Decimal("0.2"), remainingQuantity: new Prisma.Decimal("5") },
      { side: "SELL", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("2") },
    ]);

    const book = await service.getBook("market-1", "outcome-1");
    expect(book.asks.map((a) => a.price)).toEqual(["0.2", "0.4", "0.6"]);
  });

  it("aggregates remainingQuantity across orders at the same price level", async () => {
    restingOrders([
      { side: "BUY", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("10") },
      { side: "BUY", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("5") },
    ]);

    const book = await service.getBook("market-1", "outcome-1");
    expect(book.bids).toEqual([{ price: "0.5", remainingQuantity: "15" }]);
  });

  it("separates bids and asks independently", async () => {
    restingOrders([
      { side: "BUY", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("10") },
      { side: "SELL", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10") },
    ]);

    const book = await service.getBook("market-1", "outcome-1");
    expect(book.bids).toHaveLength(1);
    expect(book.asks).toHaveLength(1);
  });

  it("Phase 38: aggregates in the database (one row per level), never loading individual resting orders", async () => {
    restingOrders([{ side: "BUY", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("1") }]);
    await service.getBook("market-1", "outcome-1");
    expect(prisma.order.groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ["side", "price"], _sum: { remainingQuantity: true } }));
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  describe("getRestingCandidates", () => {
    it("Phase 38: applies the crossing bound in the query, keeping price-time order", async () => {
      await service.getRestingCandidates("market-1", "outcome-1", "SELL", { lte: new Prisma.Decimal("0.55") });
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ side: "SELL", price: { not: null, lte: new Prisma.Decimal("0.55") } }),
          orderBy: [{ price: "asc" }, { sequence: "asc" }],
        }),
      );
    });

    it("loads the whole side when no bound is given (unchanged behaviour for existing callers)", async () => {
      await service.getRestingCandidates("market-1", "outcome-1", "BUY");
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ price: { not: null } }), orderBy: [{ price: "desc" }, { sequence: "asc" }] }),
      );
    });
  });
});
