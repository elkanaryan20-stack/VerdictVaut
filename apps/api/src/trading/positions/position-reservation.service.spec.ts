import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { InsufficientPositionError } from "../trading.errors";
import { PositionReservationService } from "./position-reservation.service";

function makeIdempotencyConflict() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
    meta: { target: ["idempotencyKey"] },
  });
}

describe("PositionReservationService", () => {
  let service: PositionReservationService;
  let tx: {
    $executeRawUnsafe: jest.Mock;
    position: { upsert: jest.Mock; update: jest.Mock; findUniqueOrThrow: jest.Mock };
    positionReservation: {
      create: jest.Mock;
      update: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      findFirst: jest.Mock;
    };
  };

  const position = (quantity: string, reserved: string) => ({
    id: "position-1",
    quantity: new Prisma.Decimal(quantity),
    reservedQuantity: new Prisma.Decimal(reserved),
  });

  beforeEach(() => {
    tx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      position: {
        upsert: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn(),
      },
      positionReservation: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: "pres-1", ...data, status: "ACTIVE" })),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
        findFirst: jest.fn(),
      },
    };
    service = new PositionReservationService({} as PrismaService);
  });

  describe("reserve", () => {
    it("reserves shares and increases reservedQuantity", async () => {
      tx.position.upsert.mockResolvedValueOnce(position("100", "0"));

      const result = await service.reserve(tx as never, {
        userId: "user-1",
        marketId: "market-1",
        outcomeId: "outcome-1",
        amount: "40",
        referenceType: "Order",
        referenceId: "order-1",
        idempotencyKey: "order-reserve:order-1",
      });

      expect(result.alreadyReserved).toBe(false);
      const newReserved = tx.position.update.mock.calls[0][0].data.reservedQuantity as Prisma.Decimal;
      expect(newReserved.toString()).toBe("40");
    });

    it("rejects a reservation larger than what's available (never fabricates share inventory)", async () => {
      tx.position.upsert.mockResolvedValueOnce(position("0", "0")); // no prior fills -> zero shares

      await expect(
        service.reserve(tx as never, {
          userId: "user-1",
          marketId: "market-1",
          outcomeId: "outcome-1",
          amount: "10",
          referenceType: "Order",
          referenceId: "order-1",
          idempotencyKey: "order-reserve:order-1",
        }),
      ).rejects.toThrow(InsufficientPositionError);

      expect(tx.position.update).not.toHaveBeenCalled();
    });

    it("rejects a non-positive amount", async () => {
      await expect(
        service.reserve(tx as never, {
          userId: "user-1",
          marketId: "market-1",
          outcomeId: "outcome-1",
          amount: "0",
          referenceType: "Order",
          referenceId: "order-1",
          idempotencyKey: "order-reserve:order-1",
        }),
      ).rejects.toThrow();
    });

    it("treats a repeat idempotencyKey as an already-reserved no-op", async () => {
      tx.position.upsert.mockResolvedValueOnce(position("100", "0"));
      tx.positionReservation.create.mockRejectedValueOnce(makeIdempotencyConflict());
      tx.positionReservation.findUniqueOrThrow.mockResolvedValueOnce({ id: "pres-existing" });

      const result = await service.reserve(tx as never, {
        userId: "user-1",
        marketId: "market-1",
        outcomeId: "outcome-1",
        amount: "10",
        referenceType: "Order",
        referenceId: "order-1",
        idempotencyKey: "order-reserve:order-1",
      });

      expect(result).toEqual({ reservationId: "pres-existing", alreadyReserved: true });
      expect(tx.position.update).not.toHaveBeenCalled();
    });
  });

  describe("release/capture", () => {
    it("releases an active reservation and decrements reservedQuantity", async () => {
      tx.positionReservation.updateMany.mockResolvedValueOnce({ count: 1 });
      tx.positionReservation.findUniqueOrThrow.mockResolvedValueOnce({
        id: "pres-1",
        positionId: "position-1",
        amount: new Prisma.Decimal("40"),
        consumedAmount: new Prisma.Decimal("0"),
      });
      tx.position.findUniqueOrThrow.mockResolvedValueOnce(position("100", "40"));

      const result = await service.release(tx as never, "pres-1");

      expect(result.released).toBe(true);
      const newReserved = tx.position.update.mock.calls[0][0].data.reservedQuantity as Prisma.Decimal;
      expect(newReserved.toString()).toBe("0");
    });

    it("is a no-op if the reservation is no longer ACTIVE (double-release protection)", async () => {
      tx.positionReservation.updateMany.mockResolvedValueOnce({ count: 0 });
      const result = await service.release(tx as never, "pres-1");
      expect(result.released).toBe(false);
      expect(tx.position.update).not.toHaveBeenCalled();
    });

    it("capture() is a no-op if the reservation is no longer ACTIVE (double-capture protection)", async () => {
      tx.positionReservation.updateMany.mockResolvedValueOnce({ count: 0 });
      const result = await service.capture(tx as never, "pres-1");
      expect(result.captured).toBe(false);
      expect(tx.position.update).not.toHaveBeenCalled();
    });

    it("after a partial consume, only releases the still-unconsumed remainder", async () => {
      tx.positionReservation.updateMany.mockResolvedValueOnce({ count: 1 });
      tx.positionReservation.findUniqueOrThrow.mockResolvedValueOnce({
        id: "pres-1",
        positionId: "position-1",
        amount: new Prisma.Decimal("40"),
        consumedAmount: new Prisma.Decimal("15"),
      });
      tx.position.findUniqueOrThrow.mockResolvedValueOnce(position("100", "25"));

      await service.release(tx as never, "pres-1");

      const newReserved = tx.position.update.mock.calls[0][0].data.reservedQuantity as Prisma.Decimal;
      expect(newReserved.toString()).toBe("0");
    });
  });

  describe("consume", () => {
    it("applies a partial execution without changing the reservation's status", async () => {
      tx.positionReservation.findUniqueOrThrow.mockResolvedValueOnce({
        id: "pres-1",
        positionId: "position-1",
        status: "ACTIVE",
        amount: new Prisma.Decimal("40"),
        consumedAmount: new Prisma.Decimal("0"),
      });
      tx.position.findUniqueOrThrow.mockResolvedValueOnce(position("100", "40"));

      await service.consume(tx as never, "pres-1", "15");

      const newConsumed = tx.positionReservation.update.mock.calls[0][0].data.consumedAmount as Prisma.Decimal;
      expect(newConsumed.toString()).toBe("15");
      const newReserved = tx.position.update.mock.calls[0][0].data.reservedQuantity as Prisma.Decimal;
      expect(newReserved.toString()).toBe("25");
    });

    it("rejects consuming more than what remains unconsumed", async () => {
      tx.positionReservation.findUniqueOrThrow.mockResolvedValueOnce({
        id: "pres-1",
        positionId: "position-1",
        status: "ACTIVE",
        amount: new Prisma.Decimal("40"),
        consumedAmount: new Prisma.Decimal("30"),
      });

      await expect(service.consume(tx as never, "pres-1", "15")).rejects.toThrow(/only 10 unconsumed/);
      expect(tx.positionReservation.update).not.toHaveBeenCalled();
    });

    it("rejects consuming from a reservation that is not ACTIVE", async () => {
      tx.positionReservation.findUniqueOrThrow.mockResolvedValueOnce({
        id: "pres-1",
        positionId: "position-1",
        status: "RELEASED",
        amount: new Prisma.Decimal("40"),
        consumedAmount: new Prisma.Decimal("0"),
      });

      await expect(service.consume(tx as never, "pres-1", "15")).rejects.toThrow(/status is RELEASED/);
    });
  });
});
