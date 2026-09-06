import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { FillsService } from "./fills.service";

describe("FillsService", () => {
  let service: FillsService;
  let prisma: { fill: { findMany: jest.Mock; count: jest.Mock } };

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "fill-1",
    marketId: "market-1",
    outcomeId: "outcome-1",
    buyOrderId: "buy-order-1",
    sellOrderId: "sell-order-1",
    makerOrderId: "sell-order-1",
    takerOrderId: "buy-order-1",
    buyerUserId: "user-1",
    sellerUserId: "user-2",
    price: new Prisma.Decimal("0.5"),
    quantity: new Prisma.Decimal("10"),
    fee: new Prisma.Decimal("0"),
    executedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  });

  beforeEach(() => {
    prisma = { fill: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) } };
    service = new FillsService(prisma as unknown as PrismaService);
  });

  it("scopes to fills where the caller was either the buyer or the seller", async () => {
    await service.listMine("user-1");

    expect(prisma.fill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ buyerUserId: "user-1" }, { sellerUserId: "user-1" }] } }),
    );
  });

  it("never exposes the counterparty's identity or order id — buyer's view", async () => {
    prisma.fill.findMany.mockResolvedValue([row()]);
    prisma.fill.count.mockResolvedValue(1);

    const result = await service.listMine("user-1");

    expect(result.items).toEqual([
      {
        fillId: "fill-1",
        marketId: "market-1",
        outcomeId: "outcome-1",
        orderId: "buy-order-1",
        side: "BUY",
        isMaker: false,
        price: "0.5",
        quantity: "10",
        fee: "0",
        executedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(result.items[0]).not.toHaveProperty("buyerUserId");
    expect(result.items[0]).not.toHaveProperty("sellerUserId");
    expect(JSON.stringify(result.items[0])).not.toContain("user-2");
    expect(JSON.stringify(result.items[0])).not.toContain("sell-order-1");
  });

  it("reports the seller's own order id and side when the caller was the seller", async () => {
    prisma.fill.findMany.mockResolvedValue([row({ buyerUserId: "user-9", sellerUserId: "user-1" })]);
    prisma.fill.count.mockResolvedValue(1);

    const result = await service.listMine("user-1");

    expect(result.items[0].side).toBe("SELL");
    expect(result.items[0].orderId).toBe("sell-order-1");
    expect(result.items[0].isMaker).toBe(true);
  });

  it("filters by marketId when provided", async () => {
    await service.listMine("user-1", { marketId: "market-9" });

    expect(prisma.fill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { OR: [{ buyerUserId: "user-1" }, { sellerUserId: "user-1" }], marketId: "market-9" } }),
    );
  });

  it("clamps pageSize to the maximum and page to a minimum of 1", async () => {
    const result = await service.listMine("user-1", { page: -3, pageSize: 999 });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(100);
    expect(prisma.fill.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }));
  });
});
