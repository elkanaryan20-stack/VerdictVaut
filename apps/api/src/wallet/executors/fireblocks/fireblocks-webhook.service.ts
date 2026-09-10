import { Injectable, Logger } from "@nestjs/common";
import { AuditActorType, Prisma } from "@prisma/client";
import { AuditLogService } from "../../../audit/audit-log.service";
import { LoggingMetricsService, MetricsService } from "../../../observability/metrics.service";
import { isUniqueConstraintViolation } from "../../../prisma/idempotent-create.util";
import { PrismaService } from "../../../prisma/prisma.service";
import { WithdrawalsService } from "../../withdrawals/withdrawals.service";
import { mapFireblocksResponseToStatusLookup, UnrecognizedFireblocksStatusError } from "./fireblocks-status.mapper";

export interface FireblocksWebhookEnvelope {
  type?: string;
  data?: {
    id?: string;
    status?: string;
    txHash?: string;
    externalTxId?: string;
    lastUpdated?: string;
  };
}

export type FireblocksWebhookOutcome = "processed" | "duplicate" | "unrecognized" | "error";

/**
 * Idempotent, provider-neutral-in-spirit processing of one Fireblocks
 * webhook delivery. The ONLY thing this ever writes directly is a
 * ProviderWebhookEvent audit row (see its own docblock) — every actual
 * withdrawal state transition goes through WithdrawalsService, exactly
 * like WithdrawalWatcherService's polling path, so a webhook and a poll
 * converge on the identical safe logic and can never disagree about
 * what "recording a broadcast" means.
 *
 * Fireblocks does not document a distinct webhook delivery/event id
 * (Phase 14B research pass) — `externalEventId` is instead DERIVED
 * deterministically from the transaction id + status + lastUpdated
 * triple, giving the same duplicate-delivery protection a real event id
 * would (the unique index on (provider, externalEventId) makes
 * reprocessing the identical delivery a safe no-op) without inventing
 * an id Fireblocks never sent.
 */
@Injectable()
export class FireblocksWebhookService {
  private readonly logger = new Logger(FireblocksWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly withdrawalsService: WithdrawalsService,
    private readonly auditLog: AuditLogService,
    private readonly metrics: MetricsService = new LoggingMetricsService(),
  ) {}

  async processWebhookPayload(payload: FireblocksWebhookEnvelope): Promise<FireblocksWebhookOutcome> {
    const data = payload?.data;
    if (!data?.id || !data.status) {
      // No stable id to dedupe a malformed envelope against — recorded
      // directly to the audit log (never silently dropped) rather than
      // inventing a ProviderWebhookEvent key for something we can't
      // actually correlate to anything.
      this.metrics.increment("provider_webhook_rejections_total", { provider: "fireblocks", reason: "malformed_envelope" });
      this.logger.warn(`Rejected a malformed Fireblocks webhook payload (missing data.id/data.status): ${JSON.stringify(payload).slice(0, 500)}`);
      await this.auditLog.record({
        actorType: AuditActorType.SYSTEM,
        action: "provider_webhook.rejected_malformed",
        resourceType: "ProviderWebhookEvent",
        after: { provider: "fireblocks", type: payload?.type ?? "UNKNOWN" },
      });
      return "unrecognized";
    }

    const externalEventId = `${data.id}:${data.status}:${data.lastUpdated ?? "no-timestamp"}`;
    const { row: eventRow, alreadyExisted } = await this.createEventIdempotent(externalEventId, payload.type ?? "UNKNOWN", data.id, payload);

    this.metrics.increment("provider_webhook_events_total", { provider: "fireblocks", duplicate: String(alreadyExisted) });
    if (alreadyExisted) {
      return "duplicate";
    }

    return this.interpretAndApply(eventRow.id, data);
  }

  /**
   * Re-runs interpretation for an ALREADY-RECORDED event — SUPER_ADMIN
   * operational tooling for a delivery whose first attempt failed (e.g.
   * WithdrawalsService was transiently unavailable), never for creating
   * a new event. Reads the event's own stored `payload` rather than
   * trusting anything passed in, so a reprocess can never be pointed at
   * different data than what Fireblocks actually sent. Safe to call on
   * an event that already succeeded — recordProviderBroadcast()/fail()
   * are themselves idempotent CAS transitions, so re-applying an
   * already-applied outcome is a no-op, not a double effect.
   */
  async reprocessEvent(eventId: string): Promise<FireblocksWebhookOutcome> {
    const eventRow = await this.prisma.providerWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    const payload = eventRow.payload as FireblocksWebhookEnvelope;
    const data = payload?.data;
    if (!data?.id || !data.status) {
      return "unrecognized";
    }
    return this.interpretAndApply(eventRow.id, data);
  }

  async listEvents(filters: { provider?: string; resourceId?: string } = {}, limit = 100) {
    return this.prisma.providerWebhookEvent.findMany({
      where: { provider: filters.provider, resourceId: filters.resourceId },
      orderBy: { receivedAt: "desc" },
      take: Math.min(limit, 500),
    });
  }

  private async interpretAndApply(eventId: string, data: NonNullable<FireblocksWebhookEnvelope["data"]>): Promise<FireblocksWebhookOutcome> {
    if (!data.externalTxId) {
      await this.markProcessed(eventId, "Payload has no externalTxId — cannot correlate to a VerdictVaut withdrawal.");
      return "unrecognized";
    }

    try {
      const lookup = mapFireblocksResponseToStatusLookup({ id: data.id!, status: data.status!, txHash: data.txHash });
      if (lookup.status === "broadcast" && lookup.txHash) {
        // recordProviderBroadcast is itself idempotent/out-of-order-safe
        // (only applies from PENDING_MANUAL_BROADCAST — see its own
        // docblock), so a webhook arriving after a poll already resolved
        // the same withdrawal (or vice versa) is a correct, silent no-op.
        await this.withdrawalsService.recordProviderBroadcast(data.externalTxId, lookup.txHash, lookup.providerReference);
      } else if (lookup.status === "rejected") {
        // Security review finding B1: uses the dedicated, narrower
        // failProviderRejectedSubmission() — never the general-purpose
        // fail() — so a stale/out-of-order/anomalous "rejected" webhook
        // can never release the reservation of a withdrawal that has
        // already reached BROADCAST/CONFIRMING (a real txHash exists).
        // See that method's own docblock.
        await this.withdrawalsService.failProviderRejectedSubmission(data.externalTxId, lookup.reason ?? "Provider webhook reported rejection.");
      }
      // "pending" — nothing to do yet; this event is still recorded (above) for audit/reconciliation purposes.
      await this.markProcessed(eventId, null);
      return "processed";
    } catch (error) {
      const message = error instanceof UnrecognizedFireblocksStatusError ? error.message : (error as Error).message;
      this.logger.error(`Failed to process Fireblocks webhook for withdrawal ${data.externalTxId}`, error as Error);
      this.metrics.increment("provider_webhook_rejections_total", { provider: "fireblocks", reason: "processing_error" });
      await this.markProcessed(eventId, message);
      return "error";
    }
  }

  private async createEventIdempotent(externalEventId: string, eventType: string, resourceId: string | null, payload: unknown) {
    try {
      const row = await this.prisma.providerWebhookEvent.create({
        data: {
          provider: "fireblocks",
          externalEventId,
          eventType,
          resourceType: "Withdrawal",
          resourceId,
          payload: payload as Prisma.InputJsonValue,
        },
      });
      await this.auditLog.record({
        actorType: AuditActorType.SYSTEM,
        action: "provider_webhook.received",
        resourceType: "ProviderWebhookEvent",
        resourceId: row.id,
        after: { provider: "fireblocks", eventType, resourceId },
      });
      return { row, alreadyExisted: false };
    } catch (error) {
      if (!isUniqueConstraintViolation(error, "externalEventId")) throw error;
      const existing = await this.prisma.providerWebhookEvent.findUniqueOrThrow({
        where: { provider_externalEventId: { provider: "fireblocks", externalEventId } },
      });
      return { row: existing, alreadyExisted: true };
    }
  }

  private async markProcessed(eventId: string, error: string | null): Promise<void> {
    await this.prisma.providerWebhookEvent.update({
      where: { id: eventId },
      data: { processedAt: new Date(), processingError: error, processingNote: error ? "failed" : "ok" },
    });
  }
}
