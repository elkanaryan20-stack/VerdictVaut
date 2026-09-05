import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuditLogService } from "../../audit/audit-log.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";
import { SettlementService } from "../../settlement/settlement.service";
import { SettlementAttemptFailedException } from "../../settlement/settlement.errors";
import { ResolutionService } from "./resolution.service";

describe("ResolutionService", () => {
  let service: ResolutionService;
  let prisma: {
    user: { findUnique: jest.Mock };
    market: { findUnique: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    order: { count: jest.Mock };
    marketResolution: { create: jest.Mock };
    settlement: { createMany: jest.Mock };
  };
  let txRunner: { run: jest.Mock };
  let auditLog: { record: jest.Mock };
  let settlementService: { settleMarket: jest.Mock };

  const admin = { id: "admin-1", role: "ADMIN" };
  const nonAdmin = { id: "user-1", role: "USER" };
  const market = {
    id: "market-1",
    status: "CLOSED",
    outcomes: [
      { id: "yes-1", key: "YES" },
      { id: "no-1", key: "NO" },
    ],
  };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(admin) },
      market: {
        findUnique: jest.fn().mockResolvedValue(market),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "market-1", status: "RESOLVING" }),
      },
      order: { count: jest.fn().mockResolvedValue(0) },
      marketResolution: { create: jest.fn().mockResolvedValue({}) },
      settlement: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    txRunner = { run: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)) };
    auditLog = { record: jest.fn() };
    settlementService = { settleMarket: jest.fn().mockResolvedValue({ settledCount: 0, remaining: 0, resolved: true }) };

    service = new ResolutionService(
      prisma as unknown as PrismaService,
      txRunner as unknown as SerializableTransactionRunner,
      auditLog as unknown as AuditLogService,
      settlementService as unknown as SettlementService,
    );
  });

  describe("authorization", () => {
    it("rejects resolution by a non-admin user", async () => {
      prisma.user.findUnique.mockResolvedValue(nonAdmin);
      await expect(service.resolve("market-1", "user-1", "yes-1")).rejects.toThrow(ForbiddenException);
      expect(prisma.market.updateMany).not.toHaveBeenCalled();
    });

    it("rejects resolution by an unknown user id", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.resolve("market-1", "ghost", "yes-1")).rejects.toThrow(ForbiddenException);
    });

    it("allows a SUPER_ADMIN to resolve", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "root-1", role: "SUPER_ADMIN" });
      await expect(service.resolve("market-1", "root-1", "yes-1")).resolves.toBeDefined();
    });
  });

  describe("validation", () => {
    it("rejects an outcome id that does not belong to the market", async () => {
      await expect(service.resolve("market-1", admin.id, "not-a-real-outcome")).rejects.toThrow(BadRequestException);
      expect(prisma.market.updateMany).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for a missing market", async () => {
      prisma.market.findUnique.mockResolvedValue(null);
      await expect(service.resolve("missing", admin.id, "yes-1")).rejects.toThrow(NotFoundException);
    });

    it("rejects resolution while resting orders still exist for the market (defense in depth alongside close())", async () => {
      prisma.order.count.mockResolvedValue(2);
      await expect(service.resolve("market-1", admin.id, "yes-1")).rejects.toThrow(ConflictException);
      expect(prisma.market.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("state transition", () => {
    it("rejects resolving a market that is not CLOSED (e.g. still OPEN)", async () => {
      prisma.market.findUnique.mockResolvedValue({ ...market, status: "OPEN" });
      prisma.market.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.resolve("market-1", admin.id, "yes-1")).rejects.toThrow(ConflictException);
    });

    it("rejects resolving an already-RESOLVING/RESOLVED market (duplicate resolution)", async () => {
      prisma.market.findUnique.mockResolvedValue({ ...market, status: "RESOLVING" });
      prisma.market.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.resolve("market-1", admin.id, "yes-1")).rejects.toThrow(ConflictException);
      expect(prisma.marketResolution.create).not.toHaveBeenCalled();
    });

    it("rejects resolving a CANCELLED market", async () => {
      prisma.market.findUnique.mockResolvedValue({ ...market, status: "CANCELLED" });
      prisma.market.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.resolve("market-1", admin.id, "yes-1")).rejects.toThrow(ConflictException);
    });

    it("CASes CLOSED -> RESOLVING exactly, not from any other status", async () => {
      await service.resolve("market-1", admin.id, "yes-1");
      expect(prisma.market.updateMany).toHaveBeenCalledWith({
        where: { id: "market-1", status: "CLOSED" },
        data: { status: "RESOLVING" },
      });
    });
  });

  describe("valid resolution", () => {
    it("records the MarketResolution row with resolver identity and winning outcome", async () => {
      await service.resolve("market-1", admin.id, "yes-1", "per official statement");
      expect(prisma.marketResolution.create).toHaveBeenCalledWith({
        data: { marketId: "market-1", winningOutcomeId: "yes-1", resolverId: admin.id, notes: "per official statement" },
      });
    });

    it("creates a Settlement row for EVERY outcome — winner at rate 1, everyone else at rate 0", async () => {
      await service.resolve("market-1", admin.id, "yes-1");
      const createManyArgs = prisma.settlement.createMany.mock.calls[0][0];
      expect(createManyArgs.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ outcomeId: "yes-1", payoutPerShare: "1" }),
          expect.objectContaining({ outcomeId: "no-1", payoutPerShare: "0" }),
        ]),
      );
    });

    it("audits the resolution with before/after status and the winning outcome", async () => {
      await service.resolve("market-1", admin.id, "yes-1");
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: admin.id,
          action: "market.resolve",
          resourceType: "Market",
          resourceId: "market-1",
          before: { status: "CLOSED" },
          after: { status: "RESOLVING", winningOutcomeId: "yes-1" },
        }),
      );
    });

    it("attempts settlement immediately after recording the resolution", async () => {
      await service.resolve("market-1", admin.id, "yes-1");
      expect(settlementService.settleMarket).toHaveBeenCalledWith("market-1");
    });
  });

  describe("settlement failure handling", () => {
    it("propagates a distinct SettlementAttemptFailedException — never a silent success — when settlement fails after resolution was recorded", async () => {
      settlementService.settleMarket.mockRejectedValue(new Error("boom"));
      await expect(service.resolve("market-1", admin.id, "yes-1")).rejects.toThrow(SettlementAttemptFailedException);
      // The resolution decision itself was already recorded and must not
      // be treated as having failed.
      expect(prisma.marketResolution.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("retrySettlement", () => {
    it("rejects a non-admin caller", async () => {
      prisma.user.findUnique.mockResolvedValue(nonAdmin);
      await expect(service.retrySettlement("market-1", "user-1")).rejects.toThrow(ForbiddenException);
      expect(settlementService.settleMarket).not.toHaveBeenCalled();
    });

    it("delegates to SettlementService.settleMarket and returns its result", async () => {
      settlementService.settleMarket.mockResolvedValue({ settledCount: 3, remaining: 0, resolved: true });
      const result = await service.retrySettlement("market-1", admin.id);
      expect(result).toEqual({ settledCount: 3, remaining: 0, resolved: true });
    });

    it("propagates a distinct SettlementAttemptFailedException when the retry also fails", async () => {
      settlementService.settleMarket.mockRejectedValue(new Error("still broken"));
      await expect(service.retrySettlement("market-1", admin.id)).rejects.toThrow(SettlementAttemptFailedException);
    });
  });
});
