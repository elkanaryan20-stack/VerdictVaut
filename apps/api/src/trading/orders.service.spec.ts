import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ReservationService } from "../ledger/reservation.service";
import { PrismaService } from "../prisma/prisma.service";
import { SerializableTransactionRunner } from "../prisma/serializable-transaction-runner";
import { FeeCalculator } from "./fees/fee-calculator.interface";
import { CreateOrderDto } from "./dto/create-order.dto";
import { OrdersService } from "./orders.service";
import { PositionReservationService } from "./positions/position-reservation.service";
import { OrderRiskValidator } from "./risk/order-risk-validator.service";

function makeIdempotencyConflict() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
    meta: { target: ["userId", "clientOrderId"] },
  });
}

describe("OrdersService", () => {
  let service: OrdersService;
  let prisma: {
    $executeRawUnsafe: jest.Mock;
    user: { findUniqueOrThrow: jest.Mock };
    market: { findUnique: jest.Mock };
    marketOutcome: { findUnique: jest.Mock };
    asset: { findFirstOrThrow: jest.Mock };
    order: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
  };
  let reservations: { reserve: jest.Mock; release: jest.Mock; findActiveByReference: jest.Mock };
  let positionReservations: { reserve: jest.Mock; release: jest.Mock; findActiveByReference: jest.Mock };
  let riskValidator: { validate: jest.Mock };
  let feeCalculator: { estimateBuyReserveFee: jest.Mock };
  let txRunner: { run: jest.Mock };

  const market = { id: "market-1", status: "OPEN", closeTime: null };
  const outcome = { id: "outcome-1", marketId: "market-1" };

  beforeEach(() => {
    prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "user-1", status: "ACTIVE" }) },
      market: { findUnique: jest.fn().mockResolvedValue(market) },
      marketOutcome: { findUnique: jest.fn().mockResolvedValue(outcome) },
      asset: { findFirstOrThrow: jest.fn().mockResolvedValue({ symbol: "USDC" }) },
      order: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: "order-1", ...data })),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
    };
    reservations = {
      reserve: jest.fn().mockResolvedValue({ reservationId: "res-1", alreadyReserved: false }),
      release: jest.fn(),
      findActiveByReference: jest.fn(),
    };
    positionReservations = {
      reserve: jest.fn().mockResolvedValue({ reservationId: "pres-1", alreadyReserved: false }),
      release: jest.fn(),
      findActiveByReference: jest.fn(),
    };
    riskValidator = { validate: jest.fn().mockResolvedValue(undefined) };
    feeCalculator = { estimateBuyReserveFee: jest.fn().mockReturnValue(new Prisma.Decimal(0)) };
    txRunner = { run: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)) };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      reservations as unknown as ReservationService,
      positionReservations as unknown as PositionReservationService,
      riskValidator as unknown as OrderRiskValidator,
      feeCalculator as unknown as FeeCalculator,
      txRunner as unknown as SerializableTransactionRunner,
    );
  });

  const buy = (overrides: Record<string, unknown> = {}) =>
    ({
      marketId: "market-1",
      outcomeId: "outcome-1",
      side: "BUY",
      type: "LIMIT",
      quantity: "10",
      price: "0.25",
      ...overrides,
    }) as unknown as CreateOrderDto;

  it("rejects an order from a non-ACTIVE (e.g. SUSPENDED) account", async () => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({ id: "user-1", status: "SUSPENDED" });
    await expect(service.create("user-1", buy())).rejects.toThrow(ForbiddenException);
    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it("rejects MARKET order type — not supported until a matcher exists", async () => {
    await expect(service.create("user-1", buy({ type: "MARKET" }))).rejects.toThrow(BadRequestException);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("rejects an order for a market that doesn't exist", async () => {
    prisma.market.findUnique.mockResolvedValue(null);
    await expect(service.create("user-1", buy())).rejects.toThrow(NotFoundException);
    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it("rejects an order on a market that is not OPEN", async () => {
    prisma.market.findUnique.mockResolvedValue({ id: "market-1", status: "CLOSED", closeTime: null });
    await expect(service.create("user-1", buy())).rejects.toThrow(BadRequestException);
    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it("rejects an order on a market whose closeTime has already passed, even if status is still OPEN", async () => {
    prisma.market.findUnique.mockResolvedValue({ id: "market-1", status: "OPEN", closeTime: new Date(Date.now() - 1000) });
    await expect(service.create("user-1", buy())).rejects.toThrow(BadRequestException);
  });

  it("rejects an outcome that does not belong to the market", async () => {
    prisma.marketOutcome.findUnique.mockResolvedValue({ id: "outcome-1", marketId: "some-other-market" });
    await expect(service.create("user-1", buy())).rejects.toThrow(BadRequestException);
    expect(reservations.reserve).not.toHaveBeenCalled();
  });

  it("rejects a non-positive quantity", async () => {
    await expect(service.create("user-1", buy({ quantity: "0" }))).rejects.toThrow(BadRequestException);
  });

  it("requires a price for LIMIT orders", async () => {
    await expect(service.create("user-1", buy({ price: undefined }))).rejects.toThrow(BadRequestException);
  });

  it("rejects a price outside the open probability interval (0, 1)", async () => {
    await expect(service.create("user-1", buy({ price: "1" }))).rejects.toThrow(BadRequestException);
    await expect(service.create("user-1", buy({ price: "0" }))).rejects.toThrow(BadRequestException);
  });

  it("runs risk validation before creating the order", async () => {
    await service.create("user-1", buy());
    expect(riskValidator.validate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", marketId: "market-1", outcomeId: "outcome-1", side: "BUY" }),
      prisma,
    );
  });

  it("propagates a risk-validation rejection and never creates the order", async () => {
    riskValidator.validate.mockRejectedValue(new BadRequestException("over the limit"));
    await expect(service.create("user-1", buy())).rejects.toThrow(BadRequestException);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("reserves quantity*price (+ fee) in the settlement currency for a LIMIT BUY order", async () => {
    await service.create("user-1", buy({ quantity: "10", price: "0.25" }));

    expect(reservations.reserve).toHaveBeenCalledTimes(1);
    const call = reservations.reserve.mock.calls[0][1];
    expect(call.assetSymbol).toBe("USDC");
    expect(call.amount.toString()).toBe("2.5");
    expect(call.referenceType).toBe("Order");
  });

  it("adds the fee estimate on top of the base cost for a BUY reservation", async () => {
    feeCalculator.estimateBuyReserveFee.mockReturnValue(new Prisma.Decimal("0.1"));
    await service.create("user-1", buy({ quantity: "10", price: "0.25" }));

    const call = reservations.reserve.mock.calls[0][1];
    expect(call.amount.toString()).toBe("2.6"); // 2.5 base + 0.1 fee
  });

  it("reserves outcome-share quantity via PositionReservationService for a SELL order", async () => {
    await service.create("user-1", buy({ side: "SELL", quantity: "10", price: "0.5" }));

    expect(positionReservations.reserve).toHaveBeenCalledTimes(1);
    expect(reservations.reserve).not.toHaveBeenCalled();
    const call = positionReservations.reserve.mock.calls[0][1];
    expect(call.amount.toString()).toBe("10");
    expect(call.marketId).toBe("market-1");
    expect(call.outcomeId).toBe("outcome-1");
  });

  it("rolls back (does not create a lasting order) when reservation fails — same transaction", async () => {
    reservations.reserve.mockRejectedValue(new Error("insufficient balance"));
    // Our mocked txRunner just invokes fn(prisma) without real rollback
    // semantics, so this asserts the *call shape* stays inside one run().
    await expect(service.create("user-1", buy())).rejects.toThrow("insufficient balance");
    expect(txRunner.run).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a duplicate clientOrderId returns the existing order without re-reserving", async () => {
    const clientOrderId = "retry-key-1";
    prisma.order.create.mockRejectedValueOnce(makeIdempotencyConflict());
    prisma.order.findUniqueOrThrow.mockResolvedValueOnce({
      id: "existing-order-1",
      userId: "user-1",
      status: "OPEN",
      clientOrderId,
    });

    const result = await service.create("user-1", buy({ clientOrderId }));

    expect(result.id).toBe("existing-order-1");
    expect(reservations.reserve).not.toHaveBeenCalled();
    expect(riskValidator.validate).toHaveBeenCalledTimes(1); // attempted once, inside the failed create path
  });

  it("cancel() rejects someone else's order", async () => {
    prisma.order.findUnique.mockResolvedValue({ id: "order-1", userId: "owner", status: "OPEN", side: "BUY" });
    await expect(service.cancel("someone-else", "order-1")).rejects.toThrow(ForbiddenException);
  });

  it("cancel() rejects an order that is not cancellable", async () => {
    prisma.order.findUnique.mockResolvedValue({ id: "order-1", userId: "user-1", status: "FILLED", side: "BUY" });
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.cancel("user-1", "order-1")).rejects.toThrow(BadRequestException);
  });

  it("cancel() releases the cash reservation for a BUY order", async () => {
    prisma.order.findUnique.mockResolvedValue({ id: "order-1", userId: "user-1", status: "OPEN", side: "BUY" });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUniqueOrThrow.mockResolvedValue({ id: "order-1", status: "CANCELLED" });
    reservations.findActiveByReference.mockResolvedValue({ id: "res-1" });

    await service.cancel("user-1", "order-1");

    expect(reservations.release).toHaveBeenCalledWith(prisma, "res-1");
    expect(positionReservations.release).not.toHaveBeenCalled();
  });

  it("cancel() releases the position reservation for a SELL order", async () => {
    prisma.order.findUnique.mockResolvedValue({ id: "order-1", userId: "user-1", status: "OPEN", side: "SELL" });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUniqueOrThrow.mockResolvedValue({ id: "order-1", status: "CANCELLED" });
    positionReservations.findActiveByReference.mockResolvedValue({ id: "pres-1" });

    await service.cancel("user-1", "order-1");

    expect(positionReservations.release).toHaveBeenCalledWith(prisma, "pres-1");
    expect(reservations.release).not.toHaveBeenCalled();
  });

  it("getOwnOrder() rejects another user's order", async () => {
    prisma.order.findUnique.mockResolvedValue({ id: "order-1", userId: "owner" });
    await expect(service.getOwnOrder("someone-else", "order-1")).rejects.toThrow(ForbiddenException);
  });

  it("getOwnOrder() throws NotFoundException for a missing order", async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    await expect(service.getOwnOrder("user-1", "missing")).rejects.toThrow(NotFoundException);
  });
});
