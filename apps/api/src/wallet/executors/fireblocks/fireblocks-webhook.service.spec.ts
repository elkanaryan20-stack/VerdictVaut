import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { AuditLogService } from "../../../audit/audit-log.service";
import { WithdrawalsService } from "../../withdrawals/withdrawals.service";
import { FireblocksWebhookService } from "./fireblocks-webhook.service";

function makeIdempotencyConflict() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
    meta: { target: ["provider", "externalEventId"] },
  });
}

describe("FireblocksWebhookService", () => {
  let prisma: { providerWebhookEvent: { create: jest.Mock; findUniqueOrThrow: jest.Mock; update: jest.Mock } };
  let withdrawalsService: { recordProviderBroadcast: jest.Mock; failProviderRejectedSubmission: jest.Mock };
  let auditLog: { record: jest.Mock };
  let service: FireblocksWebhookService;

  beforeEach(() => {
    prisma = {
      providerWebhookEvent: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: "event-1", ...data })),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    withdrawalsService = { recordProviderBroadcast: jest.fn().mockResolvedValue({}), failProviderRejectedSubmission: jest.fn().mockResolvedValue({}) };
    auditLog = { record: jest.fn().mockResolvedValue({}) };
    service = new FireblocksWebhookService(prisma as unknown as PrismaService, withdrawalsService as unknown as WithdrawalsService, auditLog as unknown as AuditLogService);
  });

  it("rejects a malformed envelope (missing data.id/status) without touching the withdrawal service", async () => {
    const outcome = await service.processWebhookPayload({ type: "TRANSACTION_STATUS_UPDATED" });
    expect(outcome).toBe("unrecognized");
    expect(withdrawalsService.recordProviderBroadcast).not.toHaveBeenCalled();
    expect(withdrawalsService.failProviderRejectedSubmission).not.toHaveBeenCalled();
  });

  it("reports unrecognized when the payload has no externalTxId to correlate to a withdrawal", async () => {
    const outcome = await service.processWebhookPayload({ type: "TRANSACTION_STATUS_UPDATED", data: { id: "fb-1", status: "SUBMITTED" } });
    expect(outcome).toBe("unrecognized");
  });

  it("calls recordProviderBroadcast with the real txHash for a COMPLETED status", async () => {
    const outcome = await service.processWebhookPayload({
      type: "TRANSACTION_STATUS_UPDATED",
      data: { id: "fb-1", status: "COMPLETED", txHash: "0xreal", externalTxId: "wd-1" },
    });
    expect(outcome).toBe("processed");
    expect(withdrawalsService.recordProviderBroadcast).toHaveBeenCalledWith("wd-1", "0xreal", "fb-1");
  });

  it("calls failProviderRejectedSubmission() (never the general-purpose fail()) for a REJECTED status", async () => {
    const outcome = await service.processWebhookPayload({
      type: "TRANSACTION_STATUS_UPDATED",
      data: { id: "fb-1", status: "REJECTED", externalTxId: "wd-1" },
    });
    expect(outcome).toBe("processed");
    expect(withdrawalsService.failProviderRejectedSubmission).toHaveBeenCalledWith("wd-1", expect.stringContaining("REJECTED"));
  });

  it("does nothing to the withdrawal for a merely pending status, but still records the event", async () => {
    const outcome = await service.processWebhookPayload({
      type: "TRANSACTION_STATUS_UPDATED",
      data: { id: "fb-1", status: "QUEUED", externalTxId: "wd-1" },
    });
    expect(outcome).toBe("processed");
    expect(withdrawalsService.recordProviderBroadcast).not.toHaveBeenCalled();
    expect(withdrawalsService.failProviderRejectedSubmission).not.toHaveBeenCalled();
    expect(prisma.providerWebhookEvent.create).toHaveBeenCalled();
  });

  it("is idempotent: a genuine duplicate delivery (same id+status+lastUpdated) is detected via the unique constraint and never reprocessed", async () => {
    const conflict = makeIdempotencyConflict();
    prisma.providerWebhookEvent.create.mockRejectedValueOnce(conflict);
    prisma.providerWebhookEvent.findUniqueOrThrow.mockResolvedValue({ id: "event-1" });

    const outcome = await service.processWebhookPayload({
      type: "TRANSACTION_STATUS_UPDATED",
      data: { id: "fb-1", status: "COMPLETED", txHash: "0xreal", externalTxId: "wd-1", lastUpdated: "2026-01-01T00:00:00Z" },
    });

    expect(outcome).toBe("duplicate");
    expect(withdrawalsService.recordProviderBroadcast).not.toHaveBeenCalled();
  });

  it("processes a genuinely NEW status change for the same transaction id as new information (not deduped)", async () => {
    // First delivery: SUBMITTED.
    await service.processWebhookPayload({ type: "T", data: { id: "fb-1", status: "SUBMITTED", externalTxId: "wd-1", lastUpdated: "t1" } });
    // Second delivery: same transaction, but COMPLETED with a later lastUpdated — a different externalEventId, so NOT deduped.
    const outcome = await service.processWebhookPayload({ type: "T", data: { id: "fb-1", status: "COMPLETED", txHash: "0xreal", externalTxId: "wd-1", lastUpdated: "t2" } });

    expect(outcome).toBe("processed");
    expect(withdrawalsService.recordProviderBroadcast).toHaveBeenCalledWith("wd-1", "0xreal", "fb-1");
  });

  it("returns error (never crashes) when the withdrawal-service call itself throws", async () => {
    withdrawalsService.recordProviderBroadcast.mockRejectedValue(new Error("db unavailable"));
    const outcome = await service.processWebhookPayload({
      type: "T",
      data: { id: "fb-1", status: "COMPLETED", txHash: "0xreal", externalTxId: "wd-1" },
    });
    expect(outcome).toBe("error");
  });

  describe("reprocessEvent (SUPER_ADMIN operational retry)", () => {
    it("re-reads the event's OWN stored payload (never trusts anything else) and re-applies it", async () => {
      const storedPayload = { type: "T", data: { id: "fb-1", status: "COMPLETED", txHash: "0xreal", externalTxId: "wd-1" } };
      prisma.providerWebhookEvent.findUniqueOrThrow.mockResolvedValue({ id: "event-1", payload: storedPayload });

      const outcome = await service.reprocessEvent("event-1");

      expect(outcome).toBe("processed");
      expect(withdrawalsService.recordProviderBroadcast).toHaveBeenCalledWith("wd-1", "0xreal", "fb-1");
    });

    it("reports unrecognized (never crashes) if the stored payload itself was malformed", async () => {
      prisma.providerWebhookEvent.findUniqueOrThrow.mockResolvedValue({ id: "event-1", payload: { type: "T" } });
      const outcome = await service.reprocessEvent("event-1");
      expect(outcome).toBe("unrecognized");
    });
  });
});
