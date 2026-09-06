import { AuditLogService } from "../../audit/audit-log.service";
import { LedgerService } from "../../ledger/ledger.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";
import { DepositsService } from "./deposits.service";

describe("DepositsService", () => {
  let prisma: {
    assetNetwork: { findUniqueOrThrow: jest.Mock };
    walletAddress: { findUniqueOrThrow: jest.Mock };
    deposit: { findUnique: jest.Mock; upsert: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
  };
  let ledger: { postTransaction: jest.Mock };
  let auditLog: { record: jest.Mock };
  let service: DepositsService;

  let depositRow: Record<string, unknown>;

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      userId: "user-1",
      assetSymbol: "XRP",
      assetNetworkId: "an-1",
      walletAddressId: "wa-1",
      txHash: "HASH1",
      amount: "10",
      confirmations: 5,
      requiredConfirmations: 1,
      ...overrides,
    };
  }

  beforeEach(() => {
    depositRow = null as unknown as Record<string, unknown>;

    prisma = {
      assetNetwork: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "an-1", assetId: "asset-1", memoRequired: true }) },
      walletAddress: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "wa-1", destinationTag: "999" }) },
      deposit: {
        findUnique: jest.fn(() => Promise.resolve(depositRow)),
        upsert: jest.fn((args: { create: Record<string, unknown> }) => {
          if (!depositRow) {
            depositRow = { id: "dep-1", userId: "user-1", amount: "10", ...args.create };
          }
          return Promise.resolve(depositRow);
        }),
        updateMany: jest.fn((args: { where: { status?: unknown }; data: Record<string, unknown> }) => {
          Object.assign(depositRow, args.data);
          return Promise.resolve({ count: 1 });
        }),
        findUniqueOrThrow: jest.fn(() => Promise.resolve(depositRow)),
      },
    };

    ledger = { postTransaction: jest.fn().mockResolvedValue({ transactionId: "ltx-1", alreadyPosted: false }) };
    auditLog = { record: jest.fn() };

    const txRunner = { run: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)) };

    service = new DepositsService(
      prisma as unknown as PrismaService,
      ledger as unknown as LedgerService,
      txRunner as unknown as SerializableTransactionRunner,
      auditLog as unknown as AuditLogService,
    );
  });

  describe("destination tag validation (memoRequired networks)", () => {
    it("credits when the observed tag matches the address's configured tag", async () => {
      const result = await service.recordObservedTransaction(baseInput({ destinationTag: "999" }));
      expect(result.status).toBe("CREDITED");
      expect(ledger.postTransaction).toHaveBeenCalled();
    });

    it("never credits when the destination tag is missing", async () => {
      const result = await service.recordObservedTransaction(baseInput({ destinationTag: undefined }));
      expect(result.status).toBe("FAILED");
      expect(ledger.postTransaction).not.toHaveBeenCalled();
      expect(result.failureReason).toMatch(/tag mismatch/i);
    });

    it("never credits when the destination tag does not match", async () => {
      const result = await service.recordObservedTransaction(baseInput({ destinationTag: "111" }));
      expect(result.status).toBe("FAILED");
      expect(ledger.postTransaction).not.toHaveBeenCalled();
    });

    it("always preserves the observed destination tag on the row, even when it's wrong — never discarded", async () => {
      const result = await service.recordObservedTransaction(baseInput({ destinationTag: "111" }));
      expect(result.destinationTag).toBe("111");
    });

    it("audits a tag mismatch exactly once, not on every duplicate observation", async () => {
      await service.recordObservedTransaction(baseInput({ destinationTag: "111" }));
      await service.recordObservedTransaction(baseInput({ destinationTag: "111" }));
      const mismatchAudits = auditLog.record.mock.calls.filter((c) => c[0].action === "deposit.tag_mismatch");
      expect(mismatchAudits).toHaveLength(1);
    });

    it("does not require a tag when the asset/network doesn't need one", async () => {
      prisma.assetNetwork.findUniqueOrThrow.mockResolvedValue({ id: "an-1", assetId: "asset-1", memoRequired: false });
      const result = await service.recordObservedTransaction(baseInput({ destinationTag: undefined }));
      expect(result.status).toBe("CREDITED");
    });
  });

  describe("rejectIfNotCredited", () => {
    it("transitions a PENDING deposit to REJECTED", async () => {
      depositRow = { id: "dep-1", status: "PENDING" };
      prisma.deposit.updateMany.mockImplementation((args: { data: Record<string, unknown> }) => {
        depositRow.status = args.data.status;
        return Promise.resolve({ count: 1 });
      });

      const { deposit, justRejected } = await service.rejectIfNotCredited("dep-1", "reorged out");
      expect(justRejected).toBe(true);
      expect(deposit.status).toBe("REJECTED");
    });

    it("never rejects an already-CREDITED deposit", async () => {
      depositRow = { id: "dep-1", status: "CREDITED" };
      prisma.deposit.updateMany.mockResolvedValue({ count: 0 });

      const { justRejected } = await service.rejectIfNotCredited("dep-1", "reorged out");
      expect(justRejected).toBe(false);
      expect(depositRow.status).toBe("CREDITED");
    });
  });
});
