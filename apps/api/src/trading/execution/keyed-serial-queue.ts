/**
 * Phase 38 — runs async work one-at-a-time PER KEY (here: per market),
 * with unrelated keys fully concurrent. An in-process single-writer
 * sequencer, the standard exchange pattern for a hot order book.
 *
 * Why it exists (measured, test/perf/trading.perf-spec.ts): under a
 * hot-market load, concurrent executions in the SAME market all update
 * the same few rows (the market's collateral ledger account on every
 * mint; both counterparties' accounts on every trade). SERIALIZABLE turns
 * each collision into an abort-and-retry, and at 16-way concurrency the
 * retry storm exhausted SerializableTransactionRunner's attempts for a
 * few percent of orders — funded but left unmatched (a crossed book
 * until a retry), and p95 latency in the seconds.
 *
 * What it does NOT change: isolation stays SERIALIZABLE, every CAS/
 * idempotency guard stays, and correctness never depends on this queue —
 * a second API replica is not covered by it and still falls back to the
 * database's own conflict detection and safe retries, exactly as before.
 * It only stops one process from colliding with itself.
 *
 * Memory: an entry exists only while that key has work queued/running,
 * and is removed when its tail settles — no growth with market count.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Chain after the previous task regardless of how it settled — one
    // failed execution must never wedge the market's queue.
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return result;
  }

  /** Keys with work currently queued or running — for tests/observability. */
  get activeKeys(): number {
    return this.tails.size;
  }
}
