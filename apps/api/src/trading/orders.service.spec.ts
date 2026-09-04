import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ReservationService } from "../ledger/reservation.service";
import { PrismaService } from "../prisma/prisma.service";
import { SerializableTransactionRunner } from "../prisma/serializable-transaction-runner";
import { OrdersService } from "./orders.service";

describe("OrdersService", () => {
  let service: OrdersService;
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock };
    market: { findUnique: jest.Mock };
    marketOutcome: { findUnique: jest.Mock };
    asset: { findFirstOrThrow: jest.Mock };
    order: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
  };
  let reservations: { reserve: jest.Mock; release: jest.Mock; findActiveByReference: jest.Mock };
  let txRunner: { run: jest.Mock };

  const market = { id: "market-1", status: "OPEN" };
  const outcome = { id: "outcome-1", marketId: "market-1" };

  beforeEach(() => {
    prisma = {
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "user-1", status: "ACTIVE" }) },
      market: { findUnique: jest.fn().mockResolvedValue(market) },
      marketOutcome: { findUnique: jest.fn().mockResolvedValue(outcome) },
      asset: { findFirstOrThrow: jest.fn().mockResolvedValue({ symbol: "USDC" }) },
      order: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: "order-1", ...data })),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
    };
    reservations = { reserve: jest.fn().mockResolvedValue({ reservationId: "res-1" }), release: jest.fn(), findActiveByReference: jest.fn() };
    txRunner = { run: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)) };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      reservations as unknown as ReservationService,
      txRunner as unknown as SerializableTransactionRunner,
    );
  });

  it("rejects an order from a non-ACTIVE (e.g. SUSPENDED) account", async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ id: "user-1", status: "SUSPENDED" });
    await expect(
      service.create("user-1", { marketId: "market-1", outcomeId: "outcome-1", side: "BUY", type: "LIMIT", quantity: "10", price: "0.5" }),
    ).rejects.toThrow(ForbiddenException);
    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it("rejects an order for a market that doesn't exist", async () => {
    prisma.market.findUnique.mockResolvedValue(null);
    await expect(
      service.create("user-1", { marketId: "market-1", outcomeId: "outcome-1", side: "BUY", type: "LIMIT", quantity: "10", price: "0.5" }),
    ).rejects.toThrow(NotFoundException);
    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it("rejects an order on a market that is not OPEN", async () => {
    prisma.market.findUnique.mockResolvedValue({ id: "market-1", status: "CLOSED" });
    await expect(
      service.create("user-1", { marketId: "market-1", outcomeId: "outcome-1", side: "BUY", type: "LIMIT", quantity: "10", price: "0.5" }),
    ).rejects.toThrow(BadRequestException);
    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it("rejects an outcome that does not belong to the market", async () => {
    prisma.marketOutcome.findUnique.mockResolvedValue({ id: "outcome-1", marketId: "some-other-market" });
    await expect(
      service.create("user-1", { marketId: "market-1", outcomeId: "outcome-1", side: "BUY", type: "LIMIT", quantity: "10", price: "0.5" }),
    ).rejects.toThrow(BadRequestException);
    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it("rejects a non-positive quantity", async () => {
    await expect(
      service.create("user-1", { marketId: "market-1", outcomeId: "outcome-1", side: "BUY", type: "LIMIT", quantity: "0", price: "0.5" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("requires a price for LIMIT orders", async () => {
    await expect(
      service.create("user-1", { marketId: "market-1", outcomeId: "outcome-1", side: "BUY", type: "LIMIT", quantity: "10" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a price outside the open probability interval (0, 1)", async () => {
    await expect(
      service.create("user-1", { marketId: "market-1", outcomeId: "outcome-1", side: "BUY", type: "LIMIT", quantity: "10", price: "1" }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.create("user-1", { marketId: "market-1", outcomeId: "outcome-1", side: "BUY", type: "LIMIT", quantity: "10", price: "0" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("reserves quantity*price in the settlement currency for a LIMIT BUY order", async () => {
    await service.create("user-1", {
      marketId: "market-1",
      outcomeId: "outcome-1",
      side: "BUY",
      type: "LIMIT",
      quantity: "10",
      price: "0.25",
    });

    expect(reservations.reserve).toHaveBeenCalledTimes(1);
    const call = reservations.reserve.mock.calls[0][1];
    expect(call.assetSymbol).toBe("USDC");
    expect(call.amount.toString()).toBe("2.5");
    expect(call.referenceType).toBe("Order");
  });

  it("reserves the worst-case quantity*1 for a MARKET BUY order (no known price yet)", async () => {
    await service.create("user-1", {
      marketId: "market-1",
      outcomeId: "outcome-1",
      side: "BUY",
      type: "MARKET",
      quantity: "10",
    });

    const call = reservations.reserve.mock.calls[0][1];
    expect(call.amount.toString()).toBe("10");
  });

  it("does not reserve funds for a SELL order", async () => {
    await service.create("user-1", {
      marketId: "market-1",
      outcomeId: "outcome-1",
      side: "SELL",
      type: "LIMIT",
      quantity: "10",
      price: "0.5",
    });

    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it("cancel() rejects someone else's order", async () => {
    prisma.order.findUnique.mockResolvedValue({ id: "order-1", userId: "owner", status: "OPEN" });
    await expect(service.cancel("someone-else", "order-1")).rejects.toThrow(ForbiddenException);
  });

  it("cancel() rejects an order that is not cancellable", async () => {
    prisma.order.findUnique.mockResolvedValue({ id: "order-1", userId: "user-1", status: "FILLED" });
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.cancel("user-1", "order-1")).rejects.toThrow(BadRequestException);
  });

  it("cancel() releases an active reservation", async () => {
    prisma.order.findUnique.mockResolvedValue({ id: "order-1", userId: "user-1", status: "OPEN" });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUniqueOrThrow.mockResolvedValue({ id: "order-1", status: "CANCELLED" });
    reservations.findActiveByReference.mockResolvedValue({ id: "res-1" });

    await service.cancel("user-1", "order-1");

    expect(reservations.release).toHaveBeenCalledWith(prisma, "res-1");
  });
});
