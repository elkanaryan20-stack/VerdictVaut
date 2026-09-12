# Deployment Architecture — Phase 16

How VerdictVaut's processes are meant to be deployed independently, and
the safety boundaries that keep them from silently overlapping. This
document describes what the codebase actually enforces today — it does
not claim any of this has been exercised against a real orchestrator
(Kubernetes, ECS, Nomad, ...); no such target is chosen anywhere in this
repository. See each section's own **READY FOR IMPLEMENTATION** vs
**VERIFIED** (or **PARTIALLY VERIFIED**, where CI now automatically
proves part of a claim but not all of it) marker.

## 1. The three deployable processes

| Process | Entrypoint | Binds a port? | Purpose |
|---|---|---|---|
| API | `node apps/api/dist/main.js` (Docker: `apps/api/Dockerfile`, `--target runtime`, the default) | Yes — `PORT` (default 4000) | Serves all HTTP traffic: public trading/wallet endpoints, admin endpoints, the Fireblocks webhook receiver. |
| Background worker | `node apps/api/dist/worker.main.js` (Docker: `apps/api/Dockerfile --target worker`) | No | Runs `DepositWatcherService`/`WithdrawalWatcherService` — the only two components that poll blockchains/providers. No HTTP surface at all. |
| Web | `node apps/web/server.js` (Docker: `apps/web/Dockerfile`) | Yes — `PORT` (default 3000) | Next.js frontend. Unchanged by Phase 16. |

**Status: PARTIALLY VERIFIED.** `.github/workflows/ci.yml`'s
`docker-build` job now does more than build the API image: it also
boots a real container from it against a real (throwaway, CI-only)
Postgres service and confirms `GET /health` and `GET /health/ready`
both succeed — proving the image doesn't just build but actually
starts, connects to a database, and serves HTTP traffic. This closed
the specific gap where a `docker build` success said nothing about
runtime correctness (e.g. a Prisma-client issue from the Dockerfile's
`npm prune --omit=dev` step would have built fine and only broken at
container start).

What remains **READY FOR IMPLEMENTATION, not verified**:
- The **worker** image (`--target worker`) is still build-tested only,
  not boot-tested — it has no HTTP endpoint a CI smoke test can safely
  poll for liveness (see its own `scripts/worker-healthcheck.js`
  heartbeat-file mechanism instead), and exercising it meaningfully
  would mean actually running the deposit/withdrawal watcher loop
  against seeded data, which is closer to a full integration test than
  a boot smoke test — not attempted here as a deliberate scope
  decision, not an oversight.
- **A real orchestrator** (Kubernetes, ECS, Nomad, ...) — no such
  target is chosen anywhere in this repository, and CI's Docker/Compose-
  level smoke test says nothing about how the image behaves under a
  real orchestrator's rollout/health-probe/scaling behavior.
- **An actual sandbox deposit/withdrawal processed by the worker image**
  — the CI smoke test above proves the API image's HTTP surface and DB
  connectivity, not that the worker image's watchers correctly process
  a real (sandbox) chain event end to end.

Run all of the above for real before trusting this deployment
architecture with anything beyond what CI already proves automatically.

## 2. Why a separate worker process, and how the boundary is enforced

Before this phase, `DepositWatcherService`/`WithdrawalWatcherService`
only ever ran inside the same process as the HTTP API (gated by
`CHAIN_WATCHER_ENABLED`/`WITHDRAWAL_WATCHER_ENABLED`, both off by
default). That's fine for a single small deployment, but wrong once the
API is meant to scale horizontally (N replicas behind a load balancer):
every replica would independently poll blockchains, multiplying RPC
load N times for no benefit, and coupling an HTTP replica's restart/
scaling behavior to background-job execution.

`worker.main.ts` boots a Nest **application context** (`NestFactory.
createApplicationContext`, not `NestFactory.create`) against the exact
same `AppModule` the API uses — no hand-duplicated provider wiring that
could silently drift between the two processes — but binds no HTTP
listener at all. Which watchers actually start is still controlled by
the same `CHAIN_WATCHER_ENABLED`/`WITHDRAWAL_WATCHER_ENABLED` flags;
this file only changes **where** they run.

The other half of the boundary: `apps/api/src/config/watcher-boundary.guard.ts`
runs at the very top of `main.ts`'s `bootstrap()`, **before**
`NestFactory.create()` — because the watchers' `OnModuleInit` hooks
(which start their polling timers) fire *during* app creation, a check
performed after `create()` returns would already be too late. If either
watcher flag is `true` and `ALLOW_WATCHERS_IN_API_PROCESS` is not
explicitly `true`, the API process refuses to start at all, with a
clear error naming which flag and pointing at the worker process. This
means copying the worker's `.env` onto the API deployment by mistake
fails loudly at boot, not silently.

`ALLOW_WATCHERS_IN_API_PROCESS=true` remains available as a deliberate
escape hatch for a genuinely single-process deployment (e.g. a small
self-hosted install that doesn't want two containers) — it is never the
default.

**Status: VERIFIED** (by unit test — `watcher-boundary.guard.spec.ts`,
`deposit-watcher.service.spec.ts`'s and `withdrawal-watcher.service.spec.ts`'s
new graceful-shutdown tests). Not yet exercised as two real running
containers.

## 3. Concurrent workers — what's safe, and why no new locking was added

Running more than one worker replica is safe against **duplicate
financial effects**, but for two different reasons depending on which
watcher:

- **Deposits** (`DepositWatcherService`): protected by a genuine
  per-`AssetNetwork` CAS lease (`BlockchainWatchCursor.lockedAt`/
  `lockedBy`, stale after 5 minutes — see that file's own docblock).
  This exists because there IS shared mutable state two workers could
  race on and corrupt: a single advancing scan cursor. The lease makes
  cursor ownership exclusive.
- **Withdrawals** (`WithdrawalWatcherService`): deliberately has **no**
  equivalent lease. There is no shared advancing cursor to protect —
  each pass re-lists whatever is currently BROADCAST/CONFIRMING/
  PENDING_MANUAL_BROADCAST directly from the database. The only shared
  mutable state is the `Withdrawal` row itself, and every mutation
  method it calls (`recordConfirmation`/`fail`/`recordProviderBroadcast`/
  `failProviderRejectedSubmission`, all on `WithdrawalsService`) guards
  its update with a status-scoped `updateMany` inside a transaction — a
  second worker's redundant call always matches zero rows and safely
  no-ops. Adding a lease here would protect against nothing a
  status-guarded conditional update doesn't already prevent, at the
  cost of a new schema/table and more moving parts — not built, on
  purpose (see `withdrawal-watcher.service.ts`'s own docblock).

Running multiple worker replicas therefore duplicates *read* work
(RPC/provider calls) across replicas but never duplicates a *write*
effect — worth knowing before scaling worker replica count for
throughput reasons alone (it won't help; the per-asset-network deposit
lease and the fundamentally serial nature of "list all pending
withdrawals" mean a second replica mostly re-does the first one's read
work, not additional useful work). If real horizontal worker scaling is
ever needed, that's a genuine open design question — sharding by
asset/network across replicas, most likely — not something Phase 16
invents speculatively.

**Status: VERIFIED** by reading `WithdrawalsService`'s mutation methods
(`recordConfirmation`, `fail`, `recordProviderBroadcast`,
`failProviderRejectedSubmission` — all `updateMany` with a status
filter inside `SerializableTransactionRunner`) — this is existing,
already-tested code from earlier phases, re-verified for this phase's
purposes, not new.

## 4. Graceful shutdown

Both watcher services' `onModuleDestroy` stop scheduling new poll ticks
immediately, then wait (bounded to 30s) for any poll already in flight
to finish before returning. Without this, an orchestrator's SIGTERM →
SIGKILL grace period could kill the process mid-scan, needlessly
holding a deposit-watcher lease until its 5-minute staleness timeout
even though nothing was actually still working.

That `onModuleDestroy` logic only ever runs at all if something actually
calls `app.close()` — Nest does **not** do this automatically on a
process signal. Both entrypoints now do:

- `worker.main.ts` registers its own explicit `SIGTERM`/`SIGINT`
  handlers that call `app.close()` directly, then `process.exit(0)`.
- `main.ts` (the HTTP API process) calls `app.enableShutdownHooks()`
  right after `NestFactory.create()`. This was a real gap through the
  first draft of this phase: without it, the API process had no
  shutdown-hook wiring at all, so if a deployment used the
  `ALLOW_WATCHERS_IN_API_PROCESS=true` single-process escape hatch
  (§2/§5), that process's watchers got *none* of this graceful-shutdown
  protection — a SIGTERM would kill it exactly as abruptly as before
  this phase, regardless of the new `onModuleDestroy` logic existing.
  Adding `enableShutdownHooks()` fixes this: Nest's own shutdown-hook
  implementation calls every module's `onModuleDestroy` before
  re-delivering the signal to the process's normal OS handler (see
  `@nestjs/core`'s `NestApplicationContext.listenToShutdownSignals`),
  so the API process now gets the identical protection the worker
  process already had, in both deployment modes. This is purely
  additive to `main.ts`'s existing behavior — it changes nothing about
  *whether* watchers run in the API process (that remains entirely
  decided by `watcher-boundary.guard.ts` and the
  `CHAIN_WATCHER_ENABLED`/`WITHDRAWAL_WATCHER_ENABLED` flags), only
  what happens on shutdown if they do.

**Status: VERIFIED** by unit test — both watcher spec files' "Phase 16
— graceful shutdown" describe blocks prove each service's own
`onModuleDestroy` correctly waits for an in-flight poll; a separate
`apps/api/src/shutdown-hooks.spec.ts` proves the wiring claim above
directly: a real Nest application context with the real
`DepositWatcherService`/`WithdrawalWatcherService` registered, calling
the exact `app.enableShutdownHooks()` line `main.ts` now calls, and
confirming a `SIGTERM` delivery reaches both services'
`onModuleDestroy` (via Nest's real shutdown-hook code path, with only
the final OS-level `process.kill` re-delivery mocked out so the test
can't terminate its own process). Not yet exercised against a real
orchestrator sending a real signal to a real running container — see
§1's own status note.

## 5. Sandbox / staging / production configuration boundaries

| | `APP_ENVIRONMENT` | What's different |
|---|---|---|
| Sandbox (default) | `sandbox` | Real provider adapters (Fireblocks, Elliptic) may be selected via `CustodyProviderConfig`/`ComplianceProviderConfig` rows, but only ever against each provider's own sandbox API. |
| Staging | `sandbox` (same value — there is no separate `staging` enum member) | Operationally, "staging" means a persistent, always-on deployment of the sandbox configuration, not a distinct app mode. See `docs/fireblocks-sandbox-smoke-test.md` for what preparing one actually requires (a real external Postgres — `staging-preflight-check.js` has never seen one exist yet). |
| Production | `production` | Currently refused unconditionally at boot (`env.validation.ts`) — no real custody provider is integrated yet. Even once that changes, `ProductionSafetyGate` independently re-checks the actual bound compliance gate class and real, enabled provider configuration rows at application bootstrap, and `WithdrawalExecutorFactory` fails closed rather than ever falling back to a sandbox executor. |

Containers fail safely when required configuration is missing:
`PrismaService.onModuleInit()` calls `$connect()` eagerly, so both
`main.ts` and `worker.main.ts` fail at boot (not on the first request)
if `DATABASE_URL` is unreachable; `env.validation.ts`'s `class-validator`
schema fails boot on a missing/malformed `DATABASE_URL`, undersized JWT
secrets, or an unrecognized `APP_ENVIRONMENT`; `assertDatabaseTlsConfigured`
(`config/database-tls.validator.ts`) fails boot if `APP_ENVIRONMENT=production`
and `DATABASE_URL` doesn't enforce TLS. None of this is new to Phase
16 — it's confirmed unchanged, and the new `watcher-boundary.guard.ts`
check follows the identical "fail loudly at boot, not silently at
runtime" pattern.

**Status: READY FOR IMPLEMENTATION** for anything involving a real
staging deployment (no persistent external Postgres has ever been
provisioned in any session that built this repo); **VERIFIED** for the
boot-time fail-closed checks themselves (existing, tested code).

## 6. What this phase deliberately did NOT do

- No cloud provider, Kubernetes manifests, Helm chart, Terraform, or
  managed-database provider was chosen or assumed — see
  `docs/production-database-requirements.md` §5 for why that decision
  is explicitly left to whoever owns it.
- No CI step deploys anything — `.github/workflows/ci.yml`'s
  `docker-build` job only proves the images build; it never pushes to a
  registry or deploys.
- No new database table/lease mechanism was added for withdrawal
  workers (§3) — the existing idempotent, transactional design already
  covers it.
