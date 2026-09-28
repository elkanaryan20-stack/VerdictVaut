import { performance } from "perf_hooks";
import { prisma } from "../integration/helpers";

/**
 * Phase 38 — minimal, repository-native load runner. Runs `total`
 * operations with at most `concurrency` in flight, records per-operation
 * latency and outcome, and reports throughput + percentiles. No external
 * load-testing platform; numbers are LOCAL/TEST-ENVIRONMENT measurements
 * (embedded Postgres on the developer machine) and are NOT production
 * capacity guarantees.
 */
export interface LoadResult {
  name: string;
  total: number;
  concurrency: number;
  ok: number;
  failed: number;
  errors: Record<string, number>;
  durationMs: number;
  throughputPerSec: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/**
 * Groups errors by ROOT cause (unwrapping MatchingAttemptFailedException's
 * matchingError) and by Postgres error code where one is present, so a
 * report shows e.g. "40P01 deadlock" rather than one line per order id.
 */
function errorKey(error: unknown): string {
  let inner = error as { name?: string; message?: string; matchingError?: unknown; code?: string; meta?: { code?: string } };
  const outer = inner.name ?? "Error";
  if (inner.matchingError) inner = inner.matchingError as typeof inner;
  const message = String(inner.message ?? "");
  const pgCode = message.match(/code: "?([0-9A-Z]{5})"?/)?.[1] ?? inner.meta?.code ?? inner.code;
  // Note: Prisma's P2034 text says "write conflict or a deadlock" — classified by
  // code, not by that wording.
  const hint = pgCode === "P2034" ? "write conflict / serialization (retries exhausted)" : /deadlock detected/i.test(message) ? "deadlock detected" : /could not serialize/i.test(message) ? "serialization failure" : message.replace(/[0-9a-f-]{36}/g, "<id>").replace(/\s+/g, " ").slice(0, 90);
  return `${outer} <- ${inner.name ?? "Error"} [${pgCode ?? "-"}] ${hint}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export async function runLoad(
  name: string,
  total: number,
  concurrency: number,
  op: (i: number) => Promise<unknown>,
): Promise<LoadResult> {
  const latencies: number[] = [];
  const errors: Record<string, number> = {};
  let next = 0;
  let ok = 0;
  const started = performance.now();

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const t0 = performance.now();
      try {
        await op(i);
        ok += 1;
      } catch (error) {
        errors[errorKey(error)] = (errors[errorKey(error)] ?? 0) + 1;
      } finally {
        latencies.push(performance.now() - t0);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  const durationMs = performance.now() - started;
  latencies.sort((a, b) => a - b);
  return {
    name,
    total,
    concurrency,
    ok,
    failed: total - ok,
    errors,
    durationMs: Math.round(durationMs),
    throughputPerSec: Math.round((total / durationMs) * 1000 * 10) / 10,
    p50: Math.round(percentile(latencies, 50)),
    p95: Math.round(percentile(latencies, 95)),
    p99: Math.round(percentile(latencies, 99)),
    max: Math.round(latencies[latencies.length - 1] ?? 0),
  };
}

/** Database-wide counters from pg_stat_database — rollbacks include every serialization-failure retry. */
export async function pgCounters(): Promise<{ commits: number; rollbacks: number; deadlocks: number; conflicts: number }> {
  const rows = await prisma.$queryRaw<Array<{ xact_commit: bigint; xact_rollback: bigint; deadlocks: bigint; conflicts: bigint }>>`
    SELECT xact_commit, xact_rollback, deadlocks, conflicts FROM pg_stat_database WHERE datname = current_database()`;
  const r = rows[0];
  return { commits: Number(r.xact_commit), rollbacks: Number(r.xact_rollback), deadlocks: Number(r.deadlocks), conflicts: Number(r.conflicts) };
}

export function diffCounters(before: Awaited<ReturnType<typeof pgCounters>>, after: Awaited<ReturnType<typeof pgCounters>>) {
  return {
    commits: after.commits - before.commits,
    rollbacks: after.rollbacks - before.rollbacks,
    deadlocks: after.deadlocks - before.deadlocks,
  };
}

/**
 * Post-load financial invariants, checked directly against the database
 * (independent of the services that produced the state). Every entry
 * must be zero for the run to count as correct.
 */
export async function financialInvariantViolations(): Promise<Record<string, number>> {
  const q = async (sql: string) => Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0].n);
  return {
    negativeAvailableBalance: await q(`SELECT count(*) AS n FROM ledger_accounts WHERE "ownerType" = 'USER' AND "cachedBalance" - "reservedBalance" < 0`),
    negativeReserved: await q(`SELECT count(*) AS n FROM ledger_accounts WHERE "reservedBalance" < 0`),
    reservedBalanceDrift: await q(`
      SELECT count(*) AS n FROM ledger_accounts a
      WHERE a."reservedBalance" <> COALESCE((SELECT sum(r.amount - r."consumedAmount") FROM fund_reservations r WHERE r."accountId" = a.id AND r.status = 'ACTIVE'), 0)`),
    cachedBalanceDrift: await q(`
      SELECT count(*) AS n FROM ledger_accounts a
      WHERE a."cachedBalance" <> COALESCE((SELECT sum(e.amount) FROM ledger_entries e WHERE e."accountId" = a.id), 0)`),
    unbalancedTransactions: await q(`SELECT count(*) AS n FROM (SELECT "transactionId" FROM ledger_entries GROUP BY "transactionId" HAVING sum(amount) <> 0) t`),
    negativePositions: await q(`SELECT count(*) AS n FROM positions WHERE quantity < 0 OR "reservedQuantity" < 0 OR "reservedQuantity" > quantity`),
    orderFillMismatch: await q(`
      SELECT count(*) AS n FROM orders o
      WHERE o."filledQuantity" <> COALESCE((SELECT sum(f.quantity) FROM fills f WHERE f."buyOrderId" = o.id OR f."sellOrderId" = o.id), 0)
        + COALESCE((SELECT sum(m.quantity) FROM complete_set_mints m WHERE m."buyOrderAId" = o.id OR m."buyOrderBId" = o.id), 0)`),
    orderQuantityMismatch: await q(`SELECT count(*) AS n FROM orders WHERE "filledQuantity" + "remainingQuantity" <> quantity OR "remainingQuantity" < 0`),
    terminalOrderWithActiveReservation: await q(`
      SELECT count(*) AS n FROM orders o JOIN fund_reservations r ON r."referenceType" = 'Order' AND r."referenceId" = o.id
      WHERE r.status = 'ACTIVE' AND o.status IN ('FILLED','CANCELLED','EXPIRED','REJECTED')`),
  };
}

export function printResult(result: LoadResult, extra: Record<string, unknown> = {}) {
  // Single-line JSON so the numbers can be grepped out of Jest's output.
  // eslint-disable-next-line no-console
  console.log(`PERF ${JSON.stringify({ ...result, ...extra })}`);
}
