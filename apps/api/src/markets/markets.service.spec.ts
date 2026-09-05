import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../prisma/prisma.service";
import { SerializableTransactionRunner } from "../prisma/serializable-transaction-runner";
import { MarketsService } from "./markets.service";

describe("MarketsService", () => {
  let service: MarketsService;
  let prisma: {
    marketCategory: { findUnique: jest.Mock };
    market: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
  };
  let txRunner: { run: jest.Mock };
  let auditLog: { record: jest.Mock };

  beforeEach(() => {
    prisma = {
      marketCategory: { findUnique: jest.fn() },
      market: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
    };
    txRunner = { run: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)) };
    auditLog = { record: jest.fn() };

    service = new MarketsService(
      prisma as unknown as PrismaService,
      txRunner as unknown as SerializableTransactionRunner,
      auditLog as unknown as AuditLogService,
    );
  });

  describe("create", () => {
    it("rejects an unknown category", async () => {
      prisma.marketCategory.findUnique.mockResolvedValue(null);
      await expect(
        service.create(
          { slug: "m1", title: "Market 1", description: "d", categorySlug: "nope", outcomes: [{ key: "YES", label: "Yes" }, { key: "NO", label: "No" }] },
          "admin-1",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects duplicate outcome keys", async () => {
      prisma.marketCategory.findUnique.mockResolvedValue({ id: "cat-1" });
      await expect(
        service.create(
          {
            slug: "m1",
            title: "Market 1",
            description: "d",
            categorySlug: "politics",
            outcomes: [{ key: "YES", label: "Yes" }, { key: "YES", label: "Also yes" }],
          },
          "admin-1",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates a market with ordered outcomes", async () => {
      prisma.marketCategory.findUnique.mockResolvedValue({ id: "cat-1" });
      prisma.market.create.mockImplementation(async ({ data }) => ({ id: "market-1", ...data }));

      await service.create(
        {
          slug: "m1",
          title: "Market 1",
          description: "d",
          categorySlug: "politics",
          outcomes: [{ key: "YES", label: "Yes" }, { key: "NO", label: "No" }],
        },
        "admin-1",
      );

      const createArgs = prisma.market.create.mock.calls[0][0];
      expect(createArgs.data.outcomes.create).toEqual([
        { key: "YES", label: "Yes", sortOrder: 0 },
        { key: "NO", label: "No", sortOrder: 1 },
      ]);
    });
  });

  describe("open/close", () => {
    it("open() transitions DRAFT -> OPEN and audits the change", async () => {
      prisma.market.findUnique.mockResolvedValue({ id: "market-1", status: "DRAFT" });
      prisma.market.updateMany.mockResolvedValue({ count: 1 });
      prisma.market.findUniqueOrThrow.mockResolvedValue({ id: "market-1", status: "OPEN" });

      const result = await service.open("market-1", "admin-1");

      expect(result.status).toBe("OPEN");
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: "admin-1",
          action: "market.open",
          resourceType: "Market",
          resourceId: "market-1",
          before: { status: "DRAFT" },
          after: { status: "OPEN" },
        }),
      );
    });

    it("open() rejects a market that is not DRAFT", async () => {
      prisma.market.findUnique.mockResolvedValue({ id: "market-1", status: "OPEN" });
      prisma.market.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.open("market-1", "admin-1")).rejects.toThrow(ConflictException);
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it("open() throws NotFoundException for a missing market", async () => {
      prisma.market.findUnique.mockResolvedValue(null);
      await expect(service.open("missing", "admin-1")).rejects.toThrow(NotFoundException);
    });

    it("close() transitions OPEN -> CLOSED", async () => {
      prisma.market.findUnique.mockResolvedValue({ id: "market-1", status: "OPEN" });
      prisma.market.updateMany.mockResolvedValue({ count: 1 });
      prisma.market.findUniqueOrThrow.mockResolvedValue({ id: "market-1", status: "CLOSED" });

      const result = await service.close("market-1", "admin-1");
      expect(result.status).toBe("CLOSED");
    });

    it("close() rejects an already-CLOSED market (terminal-ish state guard)", async () => {
      prisma.market.findUnique.mockResolvedValue({ id: "market-1", status: "CLOSED" });
      prisma.market.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.close("market-1", "admin-1")).rejects.toThrow(ConflictException);
    });
  });
});
