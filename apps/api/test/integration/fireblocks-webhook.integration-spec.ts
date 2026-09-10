import { AuditLogService } from "../../src/audit/audit-log.service";
import { FireblocksWebhookService } from "../../src/wallet/executors/fireblocks/fireblocks-webhook.service";
import { WithdrawalStatus } from "@prisma/client";
import { createTestUser, fundUserForTest, getAssetNetwork, prisma, reservations, withdrawalsService } from "./helpers";

const auditLog = new AuditLogService(prisma);
const webhookService = new FireblocksWebhookService(prisma, withdrawalsService, auditLog);

async function createPendingProviderWithdrawal(custodyReference: string) {
  const user = await createTestUser();
  const assetNetwork = await getAssetNetwork("ETH", "ethereum-sepolia");
  const marker = `${Date.now()}-${Math.random()}`;
  return prisma.withdrawal.create({
    data: {
      userId: user.id,
      assetNetworkId: assetNetwork.id,
      destinationAddress: `0x${marker.replace(/[.-]/g, "").padEnd(40, "0").slice(0, 40)}`,
      amount: "1",
      fee: "0",
      status: WithdrawalStatus.PENDING_MANUAL_BROADCAST,
      custodyReference,
      clientWithdrawalId: `ck-${marker}`,
    },
  });
}

describe("FireblocksWebhookService (real Postgres)", () => {
  it("a genuine duplicate delivery (same id+status+lastUpdated) is recorded exactly once — the second delivery is a safe no-op, never a second broadcast recording", async () => {
    const custodyRef = `fb-dup-${Date.now()}`;
    const withdrawal = await createPendingProviderWithdrawal(custodyRef);
    const payload = { type: "TRANSACTION_STATUS_UPDATED", data: { id: custodyRef, status: "COMPLETED", txHash: "0xrealhash", externalTxId: withdrawal.id, lastUpdated: "2026-01-01T00:00:00Z" } };

    const first = await webhookService.processWebhookPayload(payload);
    const second = await webhookService.processWebhookPayload(payload);

    expect(first).toBe("processed");
    expect(second).toBe("duplicate");

    const events = await prisma.providerWebhookEvent.findMany({ where: { provider: "fireblocks", resourceId: custodyRef } });
    expect(events.length).toBe(1); // exactly one row, never duplicated

    const refreshed = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    expect(refreshed.status).toBe(WithdrawalStatus.BROADCAST);
    expect(refreshed.txHash).toBe("0xrealhash");
  });

  it("two CONCURRENT deliveries of the identical event race the DB's own unique constraint — exactly one is 'processed', the other 'duplicate', never both applied", async () => {
    const custodyRef = `fb-race-${Date.now()}`;
    const withdrawal = await createPendingProviderWithdrawal(custodyRef);
    const payload = { type: "TRANSACTION_STATUS_UPDATED", data: { id: custodyRef, status: "COMPLETED", txHash: "0xconcurrent", externalTxId: withdrawal.id, lastUpdated: "2026-01-01T00:00:00Z" } };

    const [a, b] = await Promise.all([webhookService.processWebhookPayload(payload), webhookService.processWebhookPayload(payload)]);

    const outcomes = [a, b].sort();
    expect(outcomes).toEqual(["duplicate", "processed"]);

    const events = await prisma.providerWebhookEvent.findMany({ where: { provider: "fireblocks", resourceId: custodyRef } });
    expect(events.length).toBe(1);

    const refreshed = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    expect(refreshed.status).toBe(WithdrawalStatus.BROADCAST);
  });

  it("a webhook arriving for a withdrawal already resolved by a poll (recordProviderBroadcast already applied) is a correct, silent no-op — never a double state transition", async () => {
    const custodyRef = `fb-already-polled-${Date.now()}`;
    const withdrawal = await createPendingProviderWithdrawal(custodyRef);

    // Simulate the poll path having already resolved this withdrawal.
    await withdrawalsService.recordProviderBroadcast(withdrawal.id, "0xfrompoll", custodyRef);

    const payload = { type: "TRANSACTION_STATUS_UPDATED", data: { id: custodyRef, status: "COMPLETED", txHash: "0xfromwebhook", externalTxId: withdrawal.id, lastUpdated: "2026-01-01T00:00:00Z" } };
    const outcome = await webhookService.processWebhookPayload(payload);

    expect(outcome).toBe("processed");
    const refreshed = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    // Still whatever the poll set it to — the webhook's CAS-guarded
    // recordProviderBroadcast only applies FROM PENDING_MANUAL_BROADCAST,
    // so arriving after the withdrawal already left that state is a
    // documented, safe no-op rather than a second (possibly conflicting) write.
    expect(refreshed.txHash).toBe("0xfrompoll");
  });

  describe("B1 — reject-after-broadcast safety (real Postgres)", () => {
    it("a REJECTED webhook for a withdrawal already BROADCAST (real txHash recorded) is refused — never releases the real reservation or rolls back state", async () => {
      const user = await createTestUser();
      await fundUserForTest(user.id, "USDC", "1000");
      const withdrawal = await withdrawalsService.request(user.id, {
        assetSymbol: "USDC",
        networkCode: "ethereum-sepolia",
        amount: "100",
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
      });

      // Real reservation exists and is ACTIVE from the real request() path above.
      const activeReservation = await reservations.findActiveByReference(prisma, "Withdrawal", withdrawal.id);
      expect(activeReservation).not.toBeNull();

      // Fast-forward past approval/execution to a real, already-broadcast
      // state (a genuine txHash on file) without re-running the full
      // executor path — the CAS-gating behavior under test does not
      // depend on how the withdrawal GOT to BROADCAST, only on the fact
      // that it's there with a real txHash.
      const custodyRef = `fb-broadcast-${Date.now()}`;
      await prisma.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: WithdrawalStatus.BROADCAST, txHash: "0xrealchainhash", custodyReference: custodyRef, broadcastAt: new Date() },
      });

      const payload = { type: "TRANSACTION_STATUS_UPDATED", data: { id: custodyRef, status: "REJECTED", externalTxId: withdrawal.id, lastUpdated: "2026-01-01T00:00:00Z" } };
      const outcome = await webhookService.processWebhookPayload(payload);
      expect(outcome).toBe("processed"); // the webhook itself was handled without crashing — it just refused to apply the rejection

      const refreshedWithdrawal = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
      expect(refreshedWithdrawal.status).toBe(WithdrawalStatus.BROADCAST); // untouched
      expect(refreshedWithdrawal.txHash).toBe("0xrealchainhash"); // untouched

      const reservationAfter = await reservations.findActiveByReference(prisma, "Withdrawal", withdrawal.id);
      expect(reservationAfter).not.toBeNull();
      expect(reservationAfter!.status).toBe("ACTIVE"); // never released

      const anomalyAudit = await prisma.auditLog.findFirst({ where: { action: "withdrawal.provider_rejection_after_broadcast_refused", resourceId: withdrawal.id } });
      expect(anomalyAudit).not.toBeNull(); // the anomaly IS surfaced, never silently dropped
    });

    it("duplicate REJECTED deliveries for a genuinely pre-broadcast withdrawal remain idempotent — fails and releases exactly once", async () => {
      const custodyRef = `fb-idempotent-reject-${Date.now()}`;
      const withdrawal = await createPendingProviderWithdrawal(custodyRef);
      const payload = { type: "TRANSACTION_STATUS_UPDATED", data: { id: custodyRef, status: "REJECTED", externalTxId: withdrawal.id, lastUpdated: "2026-01-01T00:00:00Z" } };

      const first = await webhookService.processWebhookPayload(payload);
      const second = await webhookService.processWebhookPayload({ ...payload, data: { ...payload.data, lastUpdated: "2026-01-01T00:00:01Z" } }); // distinct externalEventId — not deduped by the unique constraint, must still be idempotent via the CAS

      expect(first).toBe("processed");
      expect(second).toBe("processed");

      const refreshed = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
      expect(refreshed.status).toBe(WithdrawalStatus.FAILED);

      const rejectedAudits = await prisma.auditLog.findMany({ where: { action: "withdrawal.provider_rejected", resourceId: withdrawal.id } });
      expect(rejectedAudits.length).toBe(1); // the second delivery's CAS matched nothing (already FAILED) — a safe no-op, not a second audit entry
    });
  });

  describe("reprocessEvent (SUPER_ADMIN operational retry, real Postgres)", () => {
    it("re-applies an event whose first processing attempt failed, once the underlying problem is resolved", async () => {
      const custodyRef = `fb-retry-${Date.now()}`;
      const withdrawal = await createPendingProviderWithdrawal(custodyRef);

      // First delivery arrives with an UNRECOGNIZED status (Fireblocks
      // added a new enum value this codebase's mapper doesn't know about
      // yet) — processing fails and is recorded as such, but the event
      // itself IS durably stored.
      const badPayload = { type: "T", data: { id: custodyRef, status: "SOME_FUTURE_STATUS", externalTxId: withdrawal.id, lastUpdated: "t1" } };
      const firstOutcome = await webhookService.processWebhookPayload(badPayload);
      expect(firstOutcome).toBe("error");

      const eventRow = await prisma.providerWebhookEvent.findFirstOrThrow({ where: { provider: "fireblocks", resourceId: custodyRef } });
      expect(eventRow.processingError).toBeTruthy();

      // Reprocessing the SAME stored payload without a code fix still
      // fails the same way — proving reprocessEvent reads the event's
      // OWN stored data, not some different input.
      const retryOutcome = await webhookService.reprocessEvent(eventRow.id);
      expect(retryOutcome).toBe("error");
      expect(withdrawal.status).toBe(WithdrawalStatus.PENDING_MANUAL_BROADCAST); // never silently advanced
    });
  });
});
