import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ReservationService } from "../ledger/reservation.service";
import { PrismaService } from "../prisma/prisma.service";
import { SerializableTransactionRunner } from "../prisma/serializable-transaction-runner";
import { ExecutionCoordinator } from "./execution/execution-coordinator.service";
import { FeeCalculator } from "./fees/fee-calculator.interface";
import { CreateOrderDto } from "./dto/create-order.dto";
import { OrdersService, toOrderView } from "./orders.service";
import { PositionReservationService } from "./positions/position-reservation.service";
import { OrderRiskValidator } from "./risk/order-risk-validator.service";
import { MatchingAttemptFailedException } from "./trading.errors";

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
    order: { create: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock; count: jest.Mock };
    fill: { findMany: jest.Mock };
    fundReservation: { findFirst: jest.Mock };
  };
  let reservations: { reserve: jest.Mock; release: jest.Mock; findActiveByReference: jest.Mock };
  let positionReservations: { reserve: jest.Mock; release: jest.Mock; findActiveByReference: jest.Mock };
  let riskValidator: { validate: jest.Mock };
  let feeCalculator: { estimateBuyReserveFee: jest.Mock };
  let txRunner: { run: jest.Mock };
  let executionCoordinator: { matchAndExecute: jest.Mock };

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
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockImplementation(async ({ where }: { where: { id?: string } }) => ({
          id: where?.id ?? "order-1",
          status: "OPEN",
        })),
        count: jest.fn().mockResolvedValue(0),
      },
      fill: { findMany: jest.fn().mockResolvedValue([]) },
      fundReservation: { findFirst: jest.fn().mockResolvedValue(null) },
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
    executionCoordinator = { matchAndExecute: jest.fn().mockResolvedValue([]) };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      reservations as unknown as ReservationService,
      positionReservations as unknown as PositionReservationService,
      riskValidator as unknown as OrderRiskValidator,
      feeCalculator as unknown as FeeCalculator,
      txRunner as unknown as SerializableTransactionRunner,
      executionCoordinator as unknown as ExecutionCoordinator,
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
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: "existing-order-1",
      userId: "user-1",
      status: "OPEN",
      clientOrderId,
    });

    const result = await service.create("user-1", buy({ clientOrderId }));

    expect(result.id).toBe("existing-order-1");
    expect(reservations.reserve).not.toHaveBeenCalled();
    expect(riskValidator.validate).toHaveBeenCalledTimes(1); // attempted once, inside the failed create path
    expect(executionCoordinator.matchAndExecute).toHaveBeenCalledWith("existing-order-1");
  });

  it("attempts to match the order against the resting book after funding", async () => {
    await service.create("user-1", buy());
    expect(executionCoordinator.matchAndExecute).toHaveBeenCalledWith("order-1");
  });

  describe("post-funding matching failure", () => {
    it("throws a distinct MatchingAttemptFailedException — never a silent success — when the matching attempt fails", async () => {
      executionCoordinator.matchAndExecute.mockRejectedValue(new Error("boom"));
      await expect(service.create("user-1", buy())).rejects.toThrow(MatchingAttemptFailedException);
    });

    it("carries the created order's id on the thrown exception, since the order legitimately exists and is correctly funded", async () => {
      executionCoordinator.matchAndExecute.mockRejectedValue(new Error("boom"));
      await expect(service.create("user-1", buy())).rejects.toMatchObject({ orderId: "order-1" });
    });

    it("does not roll back or skip funding just because the downstream matching attempt is about to fail", async () => {
      executionCoordinator.matchAndExecute.mockRejectedValue(new Error("boom"));
      await expect(service.create("user-1", buy())).rejects.toThrow(MatchingAttemptFailedException);
      // The funding transaction (order creation + reservation) already
      // committed before matchAndExecute was ever called — a failure there
      // must never be allowed to look like the order was never placed.
      expect(prisma.order.create).toHaveBeenCalledTimes(1);
      expect(reservations.reserve).toHaveBeenCalledTimes(1);
    });
  });

  describe("retryMatching", () => {
    const restingOrder = (status: string) => ({
      id: "order-1",
      userId: "user-1",
      status,
      side: "BUY",
      quantity: "10",
      filledQuantity: "0",
      remainingQuantity: "10",
    });

    it("re-attempts matching for a still-OPEN order and returns the resulting placement summary", async () => {
      prisma.order.findUnique.mockResolvedValue(restingOrder("OPEN"));

      await service.retryMatching("user-1", "order-1");

      expect(executionCoordinator.matchAndExecute).toHaveBeenCalledWith("order-1");
    });

    it("is a safe no-op for a terminal order — never re-attempts matching on a FILLED/CANCELLED order", async () => {
      prisma.order.findUnique.mockResolvedValue(restingOrder("FILLED"));

      await service.retryMatching("user-1", "order-1");

      expect(executionCoordinator.matchAndExecute).not.toHaveBeenCalled();
    });

    it("rejects retrying someone else's order", async () => {
      prisma.order.findUnique.mockResolvedValue({ id: "order-1", userId: "owner", status: "OPEN", side: "BUY" });
      await expect(service.retryMatching("someone-else", "order-1")).rejects.toThrow(ForbiddenException);
      expect(executionCoordinator.matchAndExecute).not.toHaveBeenCalled();
    });

    it("propagates a distinct MatchingAttemptFailedException when the retried matching attempt fails again", async () => {
      prisma.order.findUnique.mockResolvedValue({ id: "order-1", userId: "user-1", status: "OPEN", side: "BUY" });
      executionCoordinator.matchAndExecute.mockRejectedValue(new Error("still broken"));

      await expect(service.retryMatching("user-1", "order-1")).rejects.toThrow(MatchingAttemptFailedException);
    });
  });

  describe("expireRestingOrdersForMarket", () => {
    it("expires every OPEN/PARTIALLY_FILLED order for the market and releases each one's own reservation", async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: "buy-1", side: "BUY", status: "OPEN" },
        { id: "sell-1", side: "SELL", status: "PARTIALLY_FILLED" },
      ]);
      reservations.findActiveByReference.mockResolvedValue({ id: "res-1" });
      positionReservations.findActiveByReference.mockResolvedValue({ id: "pres-1" });

      const count = await service.expireRestingOrdersForMarket(prisma as unknown as Prisma.TransactionClient, "market-1");

      expect(count).toBe(2);
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: "buy-1", status: "OPEN" },
        data: { status: "EXPIRED" },
      });
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: "sell-1", status: "PARTIALLY_FILLED" },
        data: { status: "EXPIRED" },
      });
      expect(reservations.release).toHaveBeenCalledWith(prisma, "res-1");
      expect(positionReservations.release).toHaveBeenCalledWith(prisma, "pres-1");
    });

    it("is a no-op with nothing to release when no orders are resting", async () => {
      prisma.order.findMany.mockResolvedValue([]);

      const count = await service.expireRestingOrdersForMarket(prisma as unknown as Prisma.TransactionClient, "market-1");

      expect(count).toBe(0);
      expect(reservations.release).not.toHaveBeenCalled();
      expect(positionReservations.release).not.toHaveBeenCalled();
    });

    it("skips releasing a reservation for an order the CAS finds already changed underneath it", async () => {
      prisma.order.findMany.mockResolvedValue([{ id: "buy-1", side: "BUY", status: "OPEN" }]);
      prisma.order.updateMany.mockResolvedValue({ count: 0 }); // something else already changed this order's status

      await service.expireRestingOrdersForMarket(prisma as unknown as Prisma.TransactionClient, "market-1");

      expect(reservations.findActiveByReference).not.toHaveBeenCalled();
      expect(reservations.release).not.toHaveBeenCalled();
    });

    it("does nothing when an order has no active reservation to release", async () => {
      prisma.order.findMany.mockResolvedValue([{ id: "buy-1", side: "BUY", status: "OPEN" }]);
      reservations.findActiveByReference.mockResolvedValue(null);

      await service.expireRestingOrdersForMarket(prisma as unknown as Prisma.TransactionClient, "market-1");

      expect(reservations.release).not.toHaveBeenCalled();
    });
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

  describe("toOrderView", () => {
    const rawOrder = {
      id: "order-1",
      userId: "user-1",
      marketId: "market-1",
      outcomeId: "outcome-1",
      side: "BUY",
      type: "LIMIT",
      price: new Prisma.Decimal("0.5"),
      quantity: new Prisma.Decimal("10"),
      filledQuantity: new Prisma.Decimal("0"),
      remainingQuantity: new Prisma.Decimal("10"),
      status: "OPEN",
      clientOrderId: "coid-1",
      sequence: 42n,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };

    it("strips the native-bigint sequence field", () => {
      const view = toOrderView(rawOrder as never);
      expect(view).not.toHaveProperty("sequence");
    });

    it("produces a JSON.stringify-safe object (a raw Order with a bigint sequence throws)", () => {
      expect(() => JSON.stringify(rawOrder)).toThrow(TypeError);
      expect(() => JSON.stringify(toOrderView(rawOrder as never))).not.toThrow();
    });

    it("passes through included market/outcome relations when present", () => {
      const withRelations = { ...rawOrder, market: { id: "market-1" }, outcome: { id: "outcome-1" } };
      const view = toOrderView(withRelations as never);
      expect(view.market).toEqual({ id: "market-1" });
      expect(view.outcome).toEqual({ id: "outcome-1" });
    });

    it("omits market/outcome keys entirely when the relation wasn't included", () => {
      const view = toOrderView(rawOrder as never);
      expect(view).not.toHaveProperty("market");
      expect(view).not.toHaveProperty("outcome");
    });
  });

  describe("listMine", () => {
    it("scopes to the caller and applies default pagination", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      const result = await service.listMine("user-1");

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" }, skip: 0, take: 20 }),
      );
      expect(prisma.order.count).toHaveBeenCalledWith({ where: { userId: "user-1" } });
      expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });

    it("applies marketId and status filters", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      await service.listMine("user-1", { marketId: "market-1", status: "OPEN" as never });

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1", marketId: "market-1", status: "OPEN" } }),
      );
      expect(prisma.order.count).toHaveBeenCalledWith({ where: { userId: "user-1", marketId: "market-1", status: "OPEN" } });
    });

    it("clamps pageSize to the maximum and page to a minimum of 1", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      const result = await service.listMine("user-1", { page: 0, pageSize: 100000 });

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(100);
      expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }));
    });

    it("falls back to defaults for a non-finite page/pageSize", async () => {
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      const result = await service.listMine("user-1", { page: NaN, pageSize: NaN });

      expect(result).toEqual(expect.objectContaining({ page: 1, pageSize: 20 }));
    });
  });
});
