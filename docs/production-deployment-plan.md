# Production Deployment Plan — Phase 24

The concrete container-deployment, rollout/rollback, and staging-parity
plan for the target architecture in
`docs/production-infrastructure-decision.md` (recommended, not
provisioned: AWS ECS Fargate + RDS for PostgreSQL). Cross-references
rather than duplicates `docs/deployment-architecture.md` (Phase 16 —
the three-process design and worker isolation), `docs/operations-runbook.md`
(Phase 16 — day-2 procedures), and `docs/production-database-requirements.md`
(Phase 16 — TLS/pooling/migration process), all re-read this session,
unchanged.

## 1. Deployment units

| | Web | API | Worker |
|---|---|---|---|
| Image target | `apps/web/Dockerfile` (`runtime` stage, implicit — single-stage named) | `apps/api/Dockerfile --target runtime` | `apps/api/Dockerfile --target worker` |
| Startup command | `node apps/web/server.js` (via `apps/web/scripts/start-standalone.js`, Phase 19) | `node apps/api/dist/main.js` | `node apps/api/dist/worker.main.js` |
| HTTP port | 3000 | 4000 | **none** |
| ECS service load balancer | Yes — ALB target group | Yes — ALB target group | **No target group at all** — AWS Fargate services may omit a load balancer entirely (confirmed against AWS's own ECS documentation this session, see `docs/production-infrastructure-decision.md`'s Phase 24 addendum) |
| Desired count (initial) | 2 (rolling-update headroom) | 2 | **1** — see §5 |

## 2. Health and readiness checks

| | Liveness | Readiness | Notes |
|---|---|---|---|
| Web | `HEALTHCHECK` in `apps/web/Dockerfile` (HTTP 200 on `/`) | Same — Next.js has no separate readiness concept here | IMPLEMENTED, unchanged |
| API | `GET /health` — process is up | `GET /health/ready` — DB reachability + blockchain-watcher staleness (informational on the API instance; the API itself never runs watchers unless the single-process opt-in is used) | Both IMPLEMENTED; `/health/ready` returns 503 the instant the DB is unreachable, proven live in Phase 18's real outage-injection test |
| Worker | Heartbeat file + `scripts/worker-healthcheck.js` (liveness only) | No separate readiness endpoint — a worker with no HTTP surface has nothing to gate traffic on; `GET /admin/watchers` (API-side, reads the same DB state) is the operational visibility point for "is it actually making progress," not a per-instance readiness probe | IMPLEMENTED; heartbeat staleness says the process is alive, not that the last scan succeeded — this is a known, documented distinction (Phase 16), not a gap introduced here |

ECS task-definition health check + ALB target-group health check
should both point at the same endpoints above for web/API. The worker
task has no ALB target group to health-check; ECS's own container-level
`HEALTHCHECK` (ECS restarts a task whose container health check fails
repeatedly) is what should gate the worker's own liveness.

## 3. Startup behavior

All three processes connect to the database eagerly at boot
(`PrismaService.onModuleInit()`) and fail closed — a container that
cannot reach the database exits/never reports healthy, rather than
starting in a half-working state (unchanged, re-verified this session).
**Migrations are never run as part of any container's startup command**
— both Dockerfiles' `CMD`s were re-read this session and confirmed to
never invoke `prisma migrate deploy`; that remains a separate deployment
step (§6 below).

## 4. Graceful shutdown

| | Mechanism |
|---|---|
| API | `main.ts` calls `app.enableShutdownHooks()` (Phase 16) — `SIGTERM` triggers NestJS's own module-destroy lifecycle |
| Worker | `worker.main.ts` registers explicit `SIGTERM`/`SIGINT` handlers calling `app.close()`, which runs every watcher's `OnModuleDestroy` (stop scheduling new polls, wait for any in-flight poll to finish) — re-verified this session by reading the current file |
| Web | Next.js's own standalone server handles `SIGTERM` natively |

ECS's default container stop timeout (30s) should be increased if a
worker poll cycle can legitimately run longer than that under load —
not measured against real production data volume in any session to
date; a conservative starting value (e.g. 60–90s) is a reasonable
initial choice pending real measurement.

## 5. Resource sizing and horizontal scaling

**No load test has been run against this schema/application at any
replica count in any session** — every number below is a conservative
starting point, not a measured value, restated from
`docs/production-infrastructure-decision.md` §6 (not re-derived
differently here):

- **Web**: stateless, horizontally scalable — start with 2 tasks
  (0.25–0.5 vCPU / 512MB–1GB each is a reasonable Fargate starting
  size for a Next.js SSR app at low-to-moderate traffic, not a
  benchmarked figure) behind the ALB, scale on CPU/request-count
  target-tracking.
- **API**: stateless per-request, horizontally scalable — start with 2
  tasks, same caveat on sizing; scale on CPU or ALB `RequestCountPerTarget`.
  Connection-pool sizing must account for replica count — see
  `docs/production-infrastructure-decision.md` §6's `connection_limit`
  guidance, unchanged by this phase.
- **Worker**: **start with, and likely stay at, 1 task.**
  `docs/deployment-architecture.md` §3 (unchanged) already documents
  why a second worker replica provides little throughput benefit at
  current scale — the deposit-watcher's per-asset-network CAS lease and
  the withdrawal-watcher's inherently serial "list all pending" design
  mean extra replicas mostly re-do the first one's read work rather
  than parallelizing it. A second replica is still *safe* (the
  lease/idempotency design prevents duplicate processing — re-verified
  this session), just not currently useful. **A genuine worker-sharding
  redesign would be required before more replicas provide real
  throughput** — not attempted this phase, out of scope.

## 6. Deployment sequence

1. **Backup first** — run the production backup mechanism (Phase 22's
   local tooling today; the chosen managed provider's mechanism once
   real) immediately before any migration touching a database with
   real data — restated from `docs/production-database-readiness.md`
   §8, unchanged.
2. **Migration** — `prisma migrate deploy`, run once, as a single
   separate step (a one-off ECS task run, or a CI/CD pipeline step with
   the production `DATABASE_URL`) — never inside a service's own
   startup. Must be additive/backward-compatible with the
   currently-running API version during a rolling deployment (expand/
   contract pattern) — unchanged guidance from Phase 23.
3. **API deployment** — rolling update (ECS's default deployment
   controller: start new tasks, wait for them to pass the ALB health
   check, then drain and stop old tasks). Old and new API versions may
   briefly coexist.
4. **Worker deployment** — independent of the API's rollout timing;
   the lease/idempotency design (§5 above) makes a brief overlap
   between old and new worker versions safe. With desired count 1,
   ECS's rolling deployment briefly runs 0 or 2 tasks depending on the
   configured minimum/maximum healthy percent — a `minimumHealthyPercent`
   of 0 (allow a brief gap, simplest) or 100 with `maximumPercent` 200
   (brief overlap, no gap) are both safe given the idempotency design;
   a brief gap only delays processing, it never duplicates or loses it
   (per the existing lease/status-guarded-`updateMany` design,
   re-verified this session).
5. **Web deployment** — independent of both; the frontend only talks
   to the API over its public HTTP contract.
6. **Readiness gate** — each service's ALB/ECS health check must pass
   before it receives production traffic — standard rolling-deployment
   behavior, not new tooling.

## 7. Rollback

| Scenario | Action |
|---|---|
| Bad application deploy, **no migration involved** | Redeploy the previous image tag for the affected service (web/API/worker independently) — no database action needed |
| Bad migration, **caught before real damage** | Write and apply a new forward migration reversing the change — Prisma generates no "down" migration, restated from `docs/operations-runbook.md` §3, unchanged. **Never attempt an automatic destructive rollback** (no tooling in this repository does this, and none should be added — a scripted "undo the last migration" is exactly the kind of blind destructive action this repository's guard-rail philosophy rejects) |
| Bad migration, **data already lost/corrupted and a forward fix can't undo it** | This is a disaster-recovery event, not a routine rollback — restore from backup per `docs/disaster-recovery-runbooks.md` runbook L, `docs/database-backup-recovery.md` §5 |
| Worker stuck/crash-looping | ECS restarts the task automatically (container health check failure); if the underlying cause is a bad deploy, redeploy the previous worker image tag independently of the API |
| Migration itself fails mid-apply | Do not force-retry blindly — `docs/disaster-recovery-runbooks.md` runbook L (migration failure) covers the investigation/recovery sequence; Prisma's `_prisma_migrations` table records partial-apply state for a human to inspect before deciding the next step |
| Readiness failure (new tasks never pass `/health/ready`) | ECS's deployment circuit breaker (if enabled) or a human aborts the rollout and redeploys the previous tag — new tasks that never become healthy never receive traffic in the first place (this is what the readiness gate in §6 is for) |

**No automatic destructive rollback is recommended anywhere in this
plan** — every path above either redeploys a known-good image (safe,
reversible) or triggers a human-reviewed disaster-recovery procedure
(deliberately not automated).

## 8. Staging parity — LOCAL → STAGING → PRODUCTION

| | LOCAL (today) | STAGING (never provisioned in any session) | PRODUCTION (not provisioned) |
|---|---|---|---|
| PostgreSQL version | 16 (`infra/docker-compose.yml`'s `postgres:16-alpine`), or `embedded-postgres` 16 for tests | Should be the exact same major version (16) — a persistent, externally-reachable Postgres 16 instance | RDS for PostgreSQL, **same major version (16)** — a version mismatch between staging and production is exactly the kind of gap a migration could silently pass in one and fail in the other |
| TLS | None (local HTTP) | Should be enabled for realism — `database-tls.validator.ts` only enforces it when `APP_ENVIRONMENT=production`, so staging TLS is a deliberate operator choice, not automatically forced | Mandatory, fail-closed |
| Environment separation | N/A — one machine | A genuinely separate database and set of provider sandbox credentials from local dev — never share a database between "staging" and any developer's local run | A genuinely separate database, secret manager namespace, and (if ever built) production custody/compliance credentials from staging |
| Service topology | Manually-started local processes, or the single-process `ALLOW_WATCHERS_IN_API_PROCESS=true` opt-in | Should mirror production's 3-service split (web/API/worker independently deployed) — Phase 18's real staging drill used 4 real OS processes (Postgres/API/worker/web) precisely to exercise this split, the closest this repository has come to real staging | Same 3-service split, at real scale/replica counts (§5) |
| Worker separation | Optional (single-process opt-in exists) | Should run as a genuinely separate process/container from the API, matching production | Mandatory — `watcher-boundary.guard.ts` refuses to boot the API process with watchers enabled unless the explicit opt-in env var is set, so an accidental merge is already guarded against at the code level, unchanged |
| Secret injection | `.env` files (git-ignored) | Should come from a real secret store, not a committed/shared `.env` — never done in any session to date | Secret manager (§ `docs/production-secret-management.md`) |
| Health checks | Reachable manually (`curl localhost:4000/health`) | Should be wired into whatever staging orchestrator exists | Wired into ECS/ALB health checks (§2) |
| Migrations | `prisma migrate dev` locally (guarded against production by `guard-destructive-migration.js`, with the documented env-var-only limitation — unchanged) | `prisma migrate deploy`, same command production uses — staging is exactly where a migration should be proven safe before it ever reaches production | `prisma migrate deploy`, run once, per §6 |
| Backup/restore drills | `npm run backup:drill -w apps/api` — real, passing, 22/22 (Phase 22), reachable and runnable today | Should exercise the same drill against a real persistent staging DB, plus the real `infra/backup.sh`/`restore.sh` pair once Docker/a real container runtime is available | Should exercise the real chosen provider's own backup/restore mechanism — **never done against any real managed provider in any session to date** |
| Observability | Console-printed structured JSON logs only | Should ship to whatever aggregator staging uses (even a lightweight one) to prove the log shape/fields are useful before production depends on them | Full observability plan — `docs/observability-and-alerting.md` + this document's §9 below |
| Provider sandbox boundaries | `NoopEmailProvider`/`ManualBroadcastExecutor`/`DeferredComplianceGate` defaults, or real Fireblocks/Elliptic **sandbox** APIs if credentials are configured (never done in any session) | Same sandbox providers, exercised against a persistent environment — the actual next concrete step this repository has needed since Phase 14B and has never had the infrastructure to attempt | Real PRODUCTION custody/compliance — **structurally blocked by design** (`ProductionCustodyExecutor` throws, `ComplianceGateFactory` forces `DeferredComplianceGate`) regardless of what cloud infrastructure exists around it |

**No persistent staging environment has ever existed in any session
that has worked on this repository.** This table is unchanged in
substance from Phase 23's own staging-parity table — restated here in
the shape the phase brief specifically asked for (LOCAL → STAGING →
PRODUCTION), not because anything materially changed this session.

## 9. Observability signal mapping

`docs/observability-and-alerting.md` §2 already defines 7 alert
conditions against real internal signals (worker processing failures,
stale cursors, reconciliation discrepancies, custody-provider failures,
repeated failed withdrawals, database availability, backup job
failure) — not duplicated here. This phase's brief asked for a broader
list; the additional items map as follows, verified against the
current source this session:

| Required signal (phase brief) | Current internal signal | Gap, if any |
|---|---|---|
| API errors | Structured JSON error logs (`JsonLoggerService`), HTTP 5xx responses visible in ALB access logs once provisioned | No dedicated error-rate metric counter exists in application code today — would rely on log-based/ALB-based metrics once shipped |
| Authentication failures | `AuthService.login()` tracks `failedLoginAttempts`/`lockedUntil` in the DB (`login-throttle.util.ts`, Phase 13) and logs via `JsonLoggerService` | No dedicated `auth.login_failed` metric counter exists — re-verified this session (grep found no `metrics.increment` call in the login path, only in the unrelated verification-email path). A real gap for alerting granularity, not previously documented this explicitly. |
| Rate limiting | NestJS `ThrottlerException` → HTTP 429 (`TRADING_THROTTLE`/`WITHDRAWAL_REQUEST_THROTTLE`/`ADMIN_MUTATION_THROTTLE`/`PROVIDER_WEBHOOK_THROTTLE`, `throttle-presets.ts`) | No dedicated internal counter either — 429s are visible in ALB target-group/access-log metrics once shipped; no application-level metric today |
| Database health | `GET /health/ready` | Covered — see `docs/observability-and-alerting.md` alert #6 |
| Worker heartbeat | Heartbeat file + `worker-healthcheck.js` | Covered structurally (§2 above); no external alert wired |
| Watcher failures | `wallet.deposit_watcher.scan_failed`, `wallet.withdrawal_watcher.poll_failed`/etc. | Covered — alert #1 |
| Deposit processing failures | Same watcher metrics | Covered — alert #1, #2 (stale cursors) |
| Withdrawal failures | `wallet.withdrawal_watcher.marked_failed`, `wallet.withdrawal.execution_ambiguous` | Covered — alert #5 |
| Reconciliation discrepancies | `wallet.reconciliation.discrepancy_found`, `settlement.collateral_reconciliation.discrepancy_found` | Covered — alert #3 |
| Custody failures | `provider_request_failures_total`, `provider_ambiguous_operations_total` | Covered — alert #4 |
| Compliance failures | Same `provider_request_failures_total` boundary, `elliptic` provider tag (Phase 14B) | Covered by the same metric family as custody; no distinct alert condition was previously written for a compliance-specific failure mode — worth a dedicated line item if a real alerting sink is ever wired, not added here (would be a metrics-code change, not a documentation-only one) |
| Email delivery failures | `email_provider_requests_total`/`email_provider_request_failures_total` (`postmark-email.provider.ts`), `auth.verification_email.send_failed` (`auth.service.ts`) | Real, verified this session — not previously listed in `docs/observability-and-alerting.md` §2's table (that table predates Phase 20's email work being folded in) — a real documentation gap this phase closes by naming it here |
| Backup failures | `infra/backups/backup-metadata.jsonl` | Covered — alert #7 |
| Readiness failures | `GET /health/ready` 503 | Covered — alert #6 |

**Two real, previously-undocumented observability gaps found this
session** (documentation findings, not fixed — a metrics-code change is
out of this documentation phase's scope): no dedicated authentication-
failure or rate-limit-rejection metric counter exists in application
code. Both are still observable today via structured logs / HTTP status
codes once shipped to any aggregator, just not as a purpose-built
counter. Not fixed here for the same reason Phase 22's connection-retry
gap and Phase 23's other findings weren't silently patched — a metrics
addition is a code change with its own review, not a byproduct of a
documentation phase.

## 10. Testing performed this session

See the final report for the exact commands and results — not
duplicated here to avoid two sources of truth for the same numbers.
