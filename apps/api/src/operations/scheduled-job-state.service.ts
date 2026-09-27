import { Injectable } from "@nestjs/common";
import { ScheduledJobState } from "@prisma/client";
import { isUniqueConstraintViolation } from "../prisma/idempotent-create.util";
import { PrismaService } from "../prisma/prisma.service";

export interface AcquireJobLeaseOptions {
  /** Opaque per-process id — never a secret (see BlockchainWatchCursor.lockedBy). */
  workerId: string;
  /** The job is only "due" if it has not STARTED within this window — the gate that stops a second replica re-running a job another replica just finished. */
  minIntervalMs: number;
  /** A lease older than this is treated as abandoned by a crashed/killed worker and may be reclaimed. */
  staleAfterMs: number;
}

/**
 * Phase 35 — the persisted lease + heartbeat behind ScheduledJobState
 * (see its schema docblock). Deliberately the same CAS shape as
 * DepositWatcherService.acquireLease (Phase 10): an idempotent upsert
 * guarantees the row exists, then ONE conditional updateMany decides the
 * winner — Postgres row-level locking on that UPDATE means two replicas
 * racing for the same due job can never both see count > 0.
 *
 * Not an advisory lock: session-level pg advisory locks don't survive
 * Prisma's connection pooling reliably, and transaction-level ones would
 * mean holding a DB transaction open across a job's chain/RPC I/O.
 */
@Injectable()
export class ScheduledJobStateService {
  constructor(private readonly prisma: PrismaService) {}

  async tryAcquire(jobKey: string, options: AcquireJobLeaseOptions): Promise<boolean> {
    await this.ensureRow(jobKey);

    const now = Date.now();
    const result = await this.prisma.scheduledJobState.updateMany({
      where: {
        jobKey,
        AND: [
          { OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now - options.staleAfterMs) } }] },
          { OR: [{ lastStartedAt: null }, { lastStartedAt: { lte: new Date(now - options.minIntervalMs) } }] },
        ],
      },
      data: { lockedAt: new Date(now), lockedBy: options.workerId, lastStartedAt: new Date(now) },
    });
    return result.count > 0;
  }

  /**
   * Releases only if THIS worker still holds the lease — a run that
   * outlived staleAfterMs and was reclaimed by another replica must not
   * clobber the new holder's lock or outcome (same guard as
   * DepositWatcherService.releaseLeaseAfterSuccess).
   */
  async release(jobKey: string, workerId: string, outcome: { ok: true; summary?: string } | { ok: false; error: string }): Promise<void> {
    await this.prisma.scheduledJobState.updateMany({
      where: { jobKey, lockedBy: workerId },
      data: {
        lockedAt: null,
        lockedBy: null,
        ...this.outcomeFields(outcome),
      },
    });
  }

  /**
   * Heartbeat for a job with no lease (e.g. the withdrawal watcher, which
   * is intentionally safe to run on every replica — see its own
   * docblock): records only when a pass started/finished and how.
   */
  async recordPass(jobKey: string, startedAt: Date, outcome: { ok: true; summary?: string } | { ok: false; error: string }): Promise<void> {
    await this.ensureRow(jobKey);
    await this.prisma.scheduledJobState.update({
      where: { jobKey },
      data: { lastStartedAt: startedAt, ...this.outcomeFields(outcome) },
    });
  }

  async list(): Promise<ScheduledJobState[]> {
    return this.prisma.scheduledJobState.findMany({ orderBy: { jobKey: "asc" } });
  }

  private outcomeFields(outcome: { ok: true; summary?: string } | { ok: false; error: string }) {
    return outcome.ok
      ? { lastSuccessAt: new Date(), lastSummary: outcome.summary?.slice(0, 2000) ?? null }
      : { lastErrorAt: new Date(), lastError: outcome.error.slice(0, 2000) };
  }

  private async ensureRow(jobKey: string): Promise<void> {
    try {
      await this.prisma.scheduledJobState.upsert({ where: { jobKey }, create: { jobKey }, update: {} });
    } catch (error) {
      // Two replicas' very-first upserts can both take the INSERT branch;
      // the row exists either way (see DepositWatcherService.acquireLease).
      if (!isUniqueConstraintViolation(error, "jobKey")) throw error;
    }
  }
}
