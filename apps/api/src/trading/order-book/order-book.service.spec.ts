import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { OrderBookService } from "./order-book.service";

describe("OrderBookService", () => {
  let service: OrderBookService;
  let prisma: { marketOutcome: { findUnique: jest.Mock }; order: { findMany: jest.Mock } };

  beforeEach(() => {
    prisma = {
      marketOutcome: { findUnique: jest.fn().mockResolvedValue({ id: "outcome-1", marketId: "market-1" }) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new OrderBookService(prisma as unknown as PrismaService);
  });

  it("rejects an outcome that does not belong to the market", async () => {
    prisma.marketOutcome.findUnique.mockResolvedValue({ id: "outcome-1", marketId: "other-market" });
    await expect(service.getBook("market-1", "outcome-1")).rejects.toThrow(NotFoundException);
  });

  it("sorts bids highest price first", async () => {
    prisma.order.findMany.mockResolvedValue([
      { side: "BUY", price: new Prisma.Decimal("0.3"), remainingQuantity: new Prisma.Decimal("10") },
      { side: "BUY", price: new Prisma.Decimal("0.7"), remainingQuantity: new Prisma.Decimal("5") },
      { side: "BUY", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("2") },
    ]);

    const book = await service.getBook("market-1", "outcome-1");
    expect(book.bids.map((b) => b.price)).toEqual(["0.7", "0.5", "0.3"]);
  });

  it("sorts asks lowest price first", async () => {
    prisma.order.findMany.mockResolvedValue([
      { side: "SELL", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10") },
      { side: "SELL", price: new Prisma.Decimal("0.2"), remainingQuantity: new Prisma.Decimal("5") },
      { side: "SELL", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("2") },
    ]);

    const book = await service.getBook("market-1", "outcome-1");
    expect(book.asks.map((a) => a.price)).toEqual(["0.2", "0.4", "0.6"]);
  });

  it("aggregates remainingQuantity across orders at the same price level", async () => {
    prisma.order.findMany.mockResolvedValue([
      { side: "BUY", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("10") },
      { side: "BUY", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("5") },
    ]);

    const book = await service.getBook("market-1", "outcome-1");
    expect(book.bids).toEqual([{ price: "0.5", remainingQuantity: "15" }]);
  });

  it("separates bids and asks independently", async () => {
    prisma.order.findMany.mockResolvedValue([
      { side: "BUY", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("10") },
      { side: "SELL", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10") },
    ]);

    const book = await service.getBook("market-1", "outcome-1");
    expect(book.bids).toHaveLength(1);
    expect(book.asks).toHaveLength(1);
  });
});
