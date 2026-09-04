import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { InsufficientBalanceError, InvalidReservationAmountError } from "./ledger.errors";
import { ReservationService } from "./reservation.service";

function makeIdempotencyConflict() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
    meta: { target: ["idempotencyKey"] },
  });
}

describe("ReservationService", () => {
  let service: ReservationService;
  let tx: {
    asset: { findUniqueOrThrow: jest.Mock };
    ledgerAccount: { upsert: jest.Mock; update: jest.Mock; findUniqueOrThrow: jest.Mock };
    fundReservation: { create: jest.Mock; findUniqueOrThrow: jest.Mock; updateMany: jest.Mock; findFirst: jest.Mock };
    $executeRawUnsafe: jest.Mock;
  };

  const asset = { id: "asset-usdc", symbol: "USDC" };
  const account = (cached: string, reserved: string) => ({
    id: "acct-1",
    cachedBalance: new Prisma.Decimal(cached),
    reservedBalance: new Prisma.Decimal(reserved),
  });

  beforeEach(() => {
    tx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      asset: { findUniqueOrThrow: jest.fn().mockResolvedValue(asset) },
      ledgerAccount: {
        upsert: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn(),
      },
      fundReservation: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: "res-1", ...data, status: "ACTIVE" })),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
        findFirst: jest.fn(),
      },
    };
    service = new ReservationService({} as PrismaService);
  });

  describe("reserve", () => {
    it("reserves funds and increases reservedBalance", async () => {
      tx.ledgerAccount.upsert.mockResolvedValueOnce(account("100", "0"));

      const result = await service.reserve(tx as never, {
        userId: "user-1",
        assetSymbol: "USDC",
        amount: "40",
        referenceType: "Withdrawal",
        referenceId: "wd-1",
        idempotencyKey: "withdrawal-reserve:wd-1",
      });

      expect(result.alreadyReserved).toBe(false);
      expect(tx.ledgerAccount.update).toHaveBeenCalledWith({
        where: { id: "acct-1" },
        data: { reservedBalance: expect.anything() },
      });
      const newReserved = tx.ledgerAccount.update.mock.calls[0][0].data.reservedBalance as Prisma.Decimal;
      expect(newReserved.toString()).toBe("40");
    });

    it("rejects a reservation larger than what's available", async () => {
      tx.ledgerAccount.upsert.mockResolvedValueOnce(account("100", "70"));

      await expect(
        service.reserve(tx as never, {
          userId: "user-1",
          assetSymbol: "USDC",
          amount: "40",
          referenceType: "Withdrawal",
          referenceId: "wd-2",
          idempotencyKey: "withdrawal-reserve:wd-2",
        }),
      ).rejects.toThrow(InsufficientBalanceError);

      expect(tx.ledgerAccount.update).not.toHaveBeenCalled();
    });

    it("rejects a non-positive amount", async () => {
      await expect(
        service.reserve(tx as never, {
          userId: "user-1",
          assetSymbol: "USDC",
          amount: "0",
          referenceType: "Order",
          referenceId: "ord-1",
          idempotencyKey: "order-reserve:ord-1",
        }),
      ).rejects.toThrow(InvalidReservationAmountError);
    });

    it("treats a repeat idempotencyKey as an already-reserved no-op", async () => {
      tx.ledgerAccount.upsert.mockResolvedValueOnce(account("100", "0"));
      tx.fundReservation.create.mockRejectedValueOnce(makeIdempotencyConflict());
      tx.fundReservation.findUniqueOrThrow.mockResolvedValueOnce({ id: "res-existing" });

      const result = await service.reserve(tx as never, {
        userId: "user-1",
        assetSymbol: "USDC",
        amount: "40",
        referenceType: "Withdrawal",
        referenceId: "wd-3",
        idempotencyKey: "withdrawal-reserve:wd-3",
      });

      expect(result).toEqual({ reservationId: "res-existing", alreadyReserved: true });
      expect(tx.ledgerAccount.update).not.toHaveBeenCalled();
    });
  });

  describe("release", () => {
    it("releases an active reservation and decrements reservedBalance", async () => {
      tx.fundReservation.updateMany.mockResolvedValueOnce({ count: 1 });
      tx.fundReservation.findUniqueOrThrow.mockResolvedValueOnce({
        id: "res-1",
        accountId: "acct-1",
        amount: new Prisma.Decimal("40"),
      });
      tx.ledgerAccount.findUniqueOrThrow.mockResolvedValueOnce(account("100", "40"));

      const result = await service.release(tx as never, "res-1");

      expect(result.released).toBe(true);
      const newReserved = tx.ledgerAccount.update.mock.calls[0][0].data.reservedBalance as Prisma.Decimal;
      expect(newReserved.toString()).toBe("0");
    });

    it("is a no-op if the reservation is no longer ACTIVE (double-release protection)", async () => {
      tx.fundReservation.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await service.release(tx as never, "res-1");

      expect(result.released).toBe(false);
      expect(tx.ledgerAccount.update).not.toHaveBeenCalled();
    });
  });

  describe("capture", () => {
    it("is a no-op if the reservation is no longer ACTIVE (double-capture protection)", async () => {
      tx.fundReservation.updateMany.mockResolvedValueOnce({ count: 0 });

      const result = await service.capture(tx as never, "res-1");

      expect(result.captured).toBe(false);
      expect(tx.ledgerAccount.update).not.toHaveBeenCalled();
    });
  });
});
