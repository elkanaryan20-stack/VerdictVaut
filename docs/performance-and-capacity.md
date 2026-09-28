# Performance & Capacity — Phase 38

> **These are local/test-environment measurements and are NOT production
> capacity guarantees.** They come from one developer machine (8 logical
> CPUs, Windows, Node 24) running embedded PostgreSQL and, for the HTTP
> numbers, the API and the load generator in the same Node process. They
> show *where* the architecture bends and whether it stays correct while
> doing so — not how many users AWS will serve. No SLA or production
> traffic figure is implied or invented here.

## 1. How to run

```
npm run perf -w apps/api                 # all benchmarks
npm run perf -w apps/api -- test/perf/trading      # one file
PERF_ORDERS=1200 PERF_CONCURRENCY=16 PERF_USERS=40  # trading knobs
PERF_DEPTHS=100,1000,4000                           # order-book depth knob
```

The harness (`apps/api/jest-perf.config.js`, `apps/api/test/perf/`) reuses the
integration suite's throwaway embedded Postgres (real migrations + seed),
creates its own disposable users/markets, never touches real funds or
external providers, and is **not** part of CI: timings are machine-dependent,
so benchmarks report numbers and assert only **correctness** (financial
invariants via direct SQL, plus `scripts/financial-integrity-checks.js`).
Plan-only bulk data for `EXPLAIN ANALYZE` lives inside a rolled-back
transaction and never persists.

## 2. Findings and changes (Phase 38)

| Finding | Evidence | Change |
|---|---|---|
| Hot-market matching retry storm: same-market executions collide on the same ledger/position rows; SERIALIZABLE aborts cascaded until `SerializableTransactionRunner` exhausted its attempts — **13% of hot-market orders funded but left unmatched** (crossed book until a retry) | `trading.perf-spec.ts` | Per-market in-process execution queue (`KeyedSerialQueue`) — isolation, CAS and idempotency unchanged |
| Deadlocks (40P01) surfaced as `PrismaClientUnknownRequestError` were never retried | same | Runner retries 40P01 like 40001; `db.transaction.retry` / `retries_exhausted` metrics |
| Every incoming order loaded the whole opposite side of the book | `data-volume.perf-spec.ts` | Load only prices that can cross (both engines stop at the first non-crossing price) |
| Public order-book endpoint loaded every resting order to return ~20 levels | same | Aggregate in SQL (`groupBy side, price`) |
| "My fills" + count scanned the platform-wide fills table | `EXPLAIN ANALYZE` (200k rows) | `fills(buyerUserId, executedAt)`, `fills(sellerUserId, executedAt)` |
| Audit-log listing: full scan + sort per page | `EXPLAIN ANALYZE` (100k rows) | `audit_logs(createdAt)` |
| Login (bcryptjs, cost 12, pure JS) monopolised the event loop: reads p95 11ms → 600ms during 4 concurrent logins | `api-http.perf-spec.ts` | Same library/cost/hash format on a small `worker_threads` pool |
| React Query auto-retried HTTP 429 twice | code review | 429 is never auto-retried |

## 3. Measured results

Environment for all rows: 8 logical CPUs, embedded Postgres 16 on the same
machine, Prisma pool `connection_limit=25`.

### Trading (1,200 order operations, concurrency 16; ~50% BUY / 35% SELL / 15% cancel)

| Scenario | Version | Failed | p50 | p95 | p99 | Throughput | Rollbacks | Deadlocks | Invariants |
|---|---|---|---|---|---|---|---|---|---|
| 1 hot market, 40 users | before | **158 (13%)** | 788ms | 6,446ms | 9,040ms | 9.0/s | 8,299 | 50 | all 0 |
| 1 hot market, 40 users | after | **0** | 486ms | 742ms | 828ms | 40.6/s | 520 | 0 | all 0 |
| 10 markets, 40 users | before | 49 (4%) | 32ms | 2,316ms | 3,904ms | 34.8/s | 3,390 | 15 | all 0 |
| 10 markets, 40 users | after | 2 | 28ms | 1,268ms | 2,162ms | 70.0/s | 1,109 | 2 | all 0 |
| 10 markets, 400 users | before | 32 (2.7%) | 42ms | 1,961ms | 2,975ms | 42.4/s | 2,914 | 5 | all 0 |
| 10 markets, 400 users | after | 1 | 30ms | 1,071ms | 1,823ms | 78.8/s | 995 | 1 | all 0 |

"Failed" = system failures (all `MatchingAttemptFailedException`: order funded
and resting, matching deferred, recoverable via `retry-matching`). Business
rejections (e.g. selling more than held) are counted separately and are not
failures. Invariants checked after every run: no negative available/reserved
balance, reservedBalance == sum of ACTIVE reservations, cachedBalance == sum
of ledger entries, every ledger transaction sums to zero, no negative/over-
reserved positions, every order's filled quantity == its fills + mints, no
active reservation on a terminal order.

### Order-book depth (resting BUYs on one outcome)

| Depth | getBook p50 before → after | Non-crossing order place+cancel p50 before → after |
|---|---|---|
| 100 | 10ms → 4ms | 94ms → 31ms |
| 4,000 | 181ms → **14ms** | 251ms → **38ms** |

### Query plans (200k fills over 20 users, 100k audit rows)

| Query | Before | After |
|---|---|---|
| My fills page (OR buyer/seller, ORDER BY executedAt, LIMIT 20) | Parallel Seq Scan, 66ms | BitmapOr of two index scans, 0.11ms |
| My fills count | Parallel Seq Scan, 56ms | 0.08ms |
| Audit logs (ORDER BY createdAt DESC LIMIT 200) | Seq Scan + top-N sort, 32ms | Index Scan Backward, 0.09ms |

### HTTP API (real AppModule, distinct X-Forwarded-For per request)

See the Phase 38 report for the full table; representative: authenticated
reads p50 12–17ms / p95 21–28ms at concurrency 16; order place+cancel p50
154ms; withdrawal request+cancel p50 130ms; login p50 1,086ms → 327ms and
concurrent-read p95 during logins 600ms → 12ms after moving bcrypt off the
event loop. Per-IP throttling stayed isolated under concurrency (a noisy IP
received 429s; other clients none).

## 4. Remaining bottlenecks (not changed — evidence or decision needed)

- **Cross-process hot markets.** The execution queue is per process. With
  several API replicas trading the same market, cross-replica collisions fall
  back to SERIALIZABLE retries (safe, slower). A single market-sequencer
  process/partitioning is the architectural next step if staging load shows
  it matters.
- **Per-user settlement account** is a hot row for a user trading many markets
  at once (the residual failures in the 10-market runs).
- **FEE_REVENUE** would become a single platform-wide hot row the moment a
  non-zero fee schedule is enabled (every trade updates it). Needs a design
  (per-market fee accounts or deferred aggregation) *before* fees go live.
- **Login is CPU-bound by design** (bcrypt cost 12 ≈ 0.3–1s CPU). The pool
  keeps the API responsive, but login throughput per replica is bounded by
  vCPUs; the 0.5-vCPU API task in Terraform will sustain only a few logins/s.
- **Offset pagination** remains on user/admin lists (fine at measured sizes).

## 5. Connection-pool sizing inputs (no final numbers invented)

Prisma opens one pool per process, default `connection_limit = 2 × CPUs + 1`,
overridable per process via `?connection_limit=` in `DATABASE_URL`.
Required inputs for staging/AWS:

```
total = api_replicas × api_pool + worker_replicas × worker_pool
      + migration/one-off tasks + admin/psql headroom
must be < RDS max_connections (instance-class dependent) with margin
```

Current Terraform: API 2 × 0.5 vCPU, worker 1 × 0.25 vCPU; DB instance class
has **no default** by design. Every SERIALIZABLE transaction holds one
connection for its duration (typically tens of ms, up to the 10s timeout),
and retries re-acquire one — size `api_pool` from measured concurrent
transactions, not from request rate.

## 6. Recommended staging load-test parameters

Run the same harness against staging's real Postgres (point `DATABASE_URL` at a
**disposable** staging database, never production):

1. Trading: `PERF_CONCURRENCY` 8 → 16 → 32, `PERF_USERS` ≥ 10× concurrency,
   1 and 10 markets; watch `db.transaction.retry` / `retries_exhausted`,
   RDS `Deadlocks`, CPU and `DatabaseConnections`.
2. Two API replicas against one hot market (measures the cross-replica case
   the in-process queue cannot cover).
3. Order-book depth 1k/10k resting orders.
4. Login bursts on the real task size (0.5 vCPU) to size the API task.
5. Success = zero invariant violations and zero integrity-check findings
   (other than harness fixtures), with the resulting latency numbers recorded
   as the first real staging baseline.
