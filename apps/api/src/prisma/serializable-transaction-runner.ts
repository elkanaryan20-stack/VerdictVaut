import { Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { StaleSnapshotConflictError } from "./idempotent-create.util";
import { LoggingMetricsService, MetricsService } from "../observability/metrics.service";
import { PrismaService } from "./prisma.service";

const SERIALIZATION_FAILURE_SQLSTATE = "40001";
const DEFAULT_MAX_ATTEMPTS = 15;
const BASE_BACKOFF_MS = 10;
const MAX_BACKOFF_MS = 250;

function isSerializationFailure(error: unknown): boolean {
  // A stale-snapshot conflict inside createIdempotent (see its docblock)
  // is not a Postgres-reported serialization failure, but it demands the
  // exact same remedy — retry the whole transaction with a fresh
  // snapshot — so it is treated as one here.
  if (error instanceof StaleSnapshotConflictError) {
    return true;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Prisma surfaces the underlying Postgres SQLSTATE on `.meta.code` for
    // errors it doesn't have a dedicated P-code for (P2034 covers some
    // cases, but not all drivers/versions), so check both.
    return (
      error.code === "P2034" ||
      (error.meta as { code?: string } | undefined)?.code === SERIALIZATION_FAILURE_SQLSTATE
    );
  }
  return false;
}

const DEADLOCK_SQLSTATE = "40P01";

/**
 * Phase 38 — a detected deadlock (40P01) aborts the victim transaction
 * in full, exactly like a serialization failure: nothing it did is kept,
 * so re-running the whole callback is equally safe. Measured under a
 * hot-market load (test/perf/trading.perf-spec.ts), deadlocks between
 * executions locking the same ledger accounts in opposite orders reached
 * the caller un-retried — ~2% of orders were funded but left unmatched
 * (MatchingAttemptFailedException) — because Prisma surfaces 40P01 as a
 * PrismaClientUnknownRequestError carrying only the message, which the
 * check above never recognized.
 */
function isDeadlock(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return (error.meta as { code?: string } | undefined)?.code === DEADLOCK_SQLSTATE;
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return error.message.includes(DEADLOCK_SQLSTATE) || /deadlock detected/i.test(error.message);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter — retrying immediately after a
 * serialization failure just re-collides with whichever other
 * transactions are also retrying at that same instant. */
function backoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.random() * exponential;
}

/**
 * The single place financial mutations open a database transaction. Every
 * caller that touches LedgerAccount, LedgerEntry, LedgerTransaction, or
 * FundReservation must go through here — it always runs at SERIALIZABLE,
 * so there is no code path where that guarantee is silently downgraded by
 * an outer transaction opened at the Postgres default (READ COMMITTED).
 *
 * SERIALIZABLE transactions can abort with a serialization failure under
 * genuine contention even when every individual statement is valid — that
 * is Postgres doing its job, not a bug — so this retries a bounded number
 * of times, with backoff, before giving up.
 *
 * IMPORTANT: `fn` may be invoked more than once and must contain only
 * database operations through the given `tx` — never an external side
 * effect (an HTTP call, a custody/executor invocation, sending an email).
 * Retrying a real-world side effect blindly is exactly the bug this
 * would reintroduce; callers that need to perform one (e.g. invoking a
 * WithdrawalExecutor) must do so outside `fn`, after a transaction has
 * committed a state transition that makes the caller the exclusive owner
 * of that side effect (see WithdrawalsService.approve for the pattern).
 */
@Injectable()
export class SerializableTransactionRunner {
  private readonly logger = new Logger(SerializableTransactionRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    // Phase 38 — optional so the many direct `new SerializableTransactionRunner(prisma)`
    // call sites (tests, scripts) are unaffected; injected in the real app.
    @Optional() private readonly metrics: MetricsService = new LoggingMetricsService(),
  ) {}

  async run<T>(
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { maxAttempts?: number } = {},
  ): Promise<T> {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5000,
          timeout: 10000,
        });
      } catch (error) {
        const deadlock = isDeadlock(error);
        const retryable = deadlock || isSerializationFailure(error);
        if (retryable && attempt < maxAttempts) {
          const delay = backoffDelay(attempt);
          this.metrics.increment("db.transaction.retry", { reason: deadlock ? "deadlock" : "serialization" });
          this.logger.warn(
            `${deadlock ? "Deadlock" : "Serialization failure"} on attempt ${attempt}/${maxAttempts} — retrying in ${delay.toFixed(0)}ms.`,
          );
          await sleep(delay);
          continue;
        }
        if (retryable) {
          // Phase 38 — out of attempts under sustained contention: surfaced
          // as its own signal (the caller only sees the final error).
          this.metrics.increment("db.transaction.retries_exhausted", { reason: deadlock ? "deadlock" : "serialization" });
        }
        throw error;
      }
    }

    // Unreachable — the loop always returns or throws — but keeps TS happy.
    throw new Error("SerializableTransactionRunner: exhausted retries without a result");
  }
}
