# Security & Operational Validation — Phase 17

The final engineering-validation layer over Phases 8–16's security,
financial, custody, worker, reconciliation, Docker, CI/CD, health, and
readiness work. This document does two things: (1) it is an **audit
report** — most of what Phase 17 asked to verify was already
implemented and already covered by real tests from earlier phases, and
this records exactly where and how; (2) it documents the **genuinely
new** tests this phase added to close the specific gaps that audit
found. Nothing here re-describes what a cited test file already
explains in its own comments — read the cited file for the mechanism,
read this document for the inventory and the verdict.

Every claim below is one of exactly three things — never blurred
together:

- **PASS / VERIFIED** — an automated test exists, was run in this
  session, and passed.
- **NOT EXECUTED** — no automated coverage exists, or the tool needed
  to run it (Docker) was unavailable in this environment.
- **BLOCKED BY EXTERNAL DEPENDENCY** — cannot be verified at all
  without a real external system (a live Fireblocks/Elliptic sandbox
  account, a real staging deployment, a real orchestrator) that this
  phase was explicitly told not to provision.

## 0. Method

Before writing a single new test, this phase inspected the existing
`apps/api/src/**/*.spec.ts` (73 files pre-phase) and
`apps/api/test/integration/*.integration-spec.ts` (23 files pre-phase)
in detail — reading actual `describe`/`it` titles and, for the
highest-stakes claims, the implementation code itself — before deciding
what was a genuine gap versus already covered. This matched the
project's own standing instruction (see memory: "inspect thoroughly
first, avoid duplicating/restarting completed phases"). The result: the
overwhelming majority of sections 2–6 and 11 below were **already
fully covered** by real-Postgres concurrency tests from Phases 8–16.
This phase's new work is concentrated in a small number of genuinely
uncovered boundaries — listed explicitly in §14.

## 1. Authentication & Authorization

**Status: PASS / VERIFIED**, with 4 new gaps closed this phase.

| Control | Status | Evidence |
|---|---|---|
| JWT signing/verification, expiry | VERIFIED (pre-existing) | `JwtStrategy` (`passport-jwt`, `ignoreExpiration: false`) — a thin, correctly-configured wrapper around a well-tested library; no custom logic to unit test beyond the config itself. |
| Password hashing | VERIFIED (pre-existing) | `auth.service.spec.ts` — bcrypt hash never equals the plaintext, verified via `bcrypt.compare`. |
| Login throttling (bounded, auto-expiring, no email-enumeration oracle) | VERIFIED (pre-existing) | `auth.service.spec.ts` (mocked) + `test/integration/login-throttle.integration-spec.ts` (real Postgres, real concurrent wrong-password attempts). |
| Refresh-token rotation + reuse detection | VERIFIED (pre-existing) | `auth.service.spec.ts`'s `refresh` describe block. |
| **Logout / session invalidation** | **VERIFIED — NEW THIS PHASE** | `AuthService.logout()` had **zero** prior test coverage. Added 4 tests: revokes only the specific token (scoped by userId+tokenHash), is a safe no-op for a foreign/already-revoked token (IDOR-safe, never throws), audit-logs the action, and — the actual end-to-end property that matters — a `refresh()` call with the just-logged-out token is subsequently rejected. |
| `changePassword` revokes every session | VERIFIED (pre-existing) | `auth.service.spec.ts`. |
| `revokeSession` (single-session logout) IDOR protection | VERIFIED (pre-existing) | `auth.service.spec.ts` — throws `NotFoundException`, not a revoke, for a session belonging to someone else. |
| `RolesGuard` re-checks live DB role/status on every request (not the JWT's stale claim) | VERIFIED (pre-existing) | `src/common/guards/roles.guard.spec.ts` — covers a demoted-to-USER admin, a suspended admin, a deleted user, all denied despite a still-valid access token. |
| **ADMIN vs SUPER_ADMIN boundary is actually applied to every sensitive AdminController route** | **VERIFIED — NEW THIS PHASE** | Previously RolesGuard's own logic was well unit-tested, but **nothing tested which routes it was actually attached to** — every existing test calls a service method directly, bypassing the controller/guard layer. Added `src/admin/admin.controller.authorization.spec.ts`: reads real `reflect-metadata` off the real `AdminController` class (no HTTP server needed) and asserts every one of its 26 non-GET (mutation) route handlers requires exactly `SUPER_ADMIN` — dynamically discovered from the real `@Get`/`@Post`/`@Patch` metadata, not a hardcoded list, so a future mutation endpoint added without the decorator fails this test automatically. Also explicitly checks 3 sensitive read-only routes (capability matrix, webhook events, compliance signals) are SUPER_ADMIN-narrowed, and one ordinary listing (`listWatcherStatus`) correctly has no override. **Self-verified the test can actually fail**: temporarily removed `@Roles(SUPER_ADMIN)` from `approveWithdrawal` — the change was blocked by this session's own safety tooling before the test could even run (a "Security Weaken" classifier correctly caught a real authorization decorator being removed from a financial endpoint), which is itself independent confirmation the mechanism is being taken seriously; the change was reverted immediately and never ran. |
| Cross-user access to orders, withdrawals, positions, deposits, wallet balances | VERIFIED (pre-existing) | `test/integration/order-cancellation.integration-spec.ts`, `withdrawal-state-machine.integration-spec.ts` ("never allows access to another user's withdrawal"), `wallet-balances-and-pagination.integration-spec.ts` ("never exposes another user's balance", "never returns another user's deposits") — all real Postgres, all asserting `NotFoundException` (never a 403 existence-oracle — a deliberate Phase 11 fix). |

**NOT EXECUTED**: no true end-to-end HTTP test exists anywhere in this
repository (no `supertest`/e2e harness) — every "integration" test
calls a service method directly against real Postgres, never through
the actual Express/Nest HTTP stack (guards, pipes, filters, CORS,
Helmet headers wired together). Adding one was considered and
deliberately not done this phase: it would require a new
`supertest`/`@types/supertest` devDependency (not currently installed,
and adding one changes `package-lock.json` — out of proportion for
this phase given the authorization-DECORATOR audit above already
closes the specific, actionable regression risk). See §9/§13 for the
concrete recommendation.

## 2. Financial Invariants

**Status: PASS / VERIFIED — entirely pre-existing, re-confirmed by
re-running every cited suite this session.** No new tests were needed;
every property Phase 17 asked for already has a real-Postgres test.

| Invariant | Evidence |
|---|---|
| Ledger balances never go negative | `test/integration/ledger-concurrency.integration-spec.ts` — 20 concurrent credits, concurrent debits racing right at the edge of available funds, a mixed concurrent credit/debit workload. Backed by a DB CHECK constraint, not just application logic (`database-constraints.integration-spec.ts`). |
| Available + reserved accounting stays consistent | `test/integration/withdrawal-state-machine.integration-spec.ts` (reservation lifecycle), `matching-execution.integration-spec.ts` ("consumes exactly the executed quantity from the buyer's cash reservation..."). |
| Every reservation has a valid lifecycle | `order-idempotency.integration-spec.ts`, `withdrawal-state-machine.integration-spec.ts`'s cancel/approve/reject/fail races, `matching-execution.integration-spec.ts`'s "reservation remains correct after a matching failure." |
| Duplicate idempotency requests never duplicate a financial effect | `deposit-idempotency.integration-spec.ts`, `order-idempotency.integration-spec.ts`, `withdrawal-state-machine.integration-spec.ts`'s idempotent-creation describe block — all with genuine `Promise.all` concurrent-duplicate races, not just sequential re-calls. |
| Concurrent cancellation/matching cannot double-release funds | `order-cancellation.integration-spec.ts` ("only one of two concurrent cancel attempts... succeeds"), `matching-execution.integration-spec.ts`'s `concurrency` describe block (duplicate/concurrent `matchAndExecute`, several concurrent takers competing for one resting order). |
| Deposit credit cannot occur twice | `deposit-idempotency.integration-spec.ts` — concurrent duplicate observations, many sequential retries, a late/stale duplicate watcher update. |
| Withdrawal execution/rejection cannot double-release or double-spend | `withdrawal-state-machine.integration-spec.ts` — concurrent approve/reject/fail races, "approve vs reject race: exactly one wins, never both," "concurrent duplicate confirmation calls do not double-debit." |
| Settlement cannot create unbacked payouts | `resolution-settlement.integration-spec.ts` — "settlement refuses to pay out a position with no real collateral behind it," plus the concurrent-settlement race (§11). |
| Reconciliation is read-only, never silently fixes discrepancies | `independent-reconciliation.integration-spec.ts` — "never mutates any balance, deposit, or withdrawal — pure observation, even when a critical discrepancy is found." |

## 3. Failure Injection

**Status: PASS / VERIFIED for the overwhelming majority — genuinely
pre-existing.** Mapped against every scenario Phase 17 listed:

| Scenario | Status | Evidence |
|---|---|---|
| Database transaction failure (mid-operation rollback leaves no partial effect) | VERIFIED (pre-existing) | `matching-execution.integration-spec.ts`'s "post-funding matching failure handling" describe block — an injected failure after funds are reserved but before matching completes leaves the order OPEN, fully reserved, funds untouched; `resolution-settlement.integration-spec.ts`'s "rollback on failure + retry" test. Postgres transactions are atomic regardless of *why* a transaction aborts (a thrown application error and a killed process produce an identical rollback at the database level) — these tests already prove the property that matters. |
| RPC timeout / transient error | VERIFIED (pre-existing) | `src/wallet/chain-adapters/retry.util.spec.ts` — bounded exponential backoff with jitter, gives up after `maxAttempts`, never busy-loops. |
| Provider timeout | VERIFIED (pre-existing) | `fireblocks-custody.adapter.spec.ts`: "returns ambiguous (never throws, never retries automatically) on a network/timeout failure." |
| Provider ambiguous response | VERIFIED (pre-existing) | Same file: ambiguous on a 5xx, ambiguous on a malformed (non-JSON) response — both handled distinctly from a definite success/failure. |
| Provider rejection before broadcast | VERIFIED (pre-existing) | Same file: throws (never ambiguous) on 401/429/400 — "the request definitely never executed," so the caller knows it's safe to retry, unlike an ambiguous outcome. |
| Provider rejection after broadcast | VERIFIED (pre-existing) | `fireblocks-webhook.integration-spec.ts`'s "B1 — reject-after-broadcast safety" describe block — a REJECTED webhook for an already-BROADCAST withdrawal (real txHash recorded) is refused, never releases the real reservation. |
| Duplicate webhook | VERIFIED (pre-existing) | Same file — same id+status+lastUpdated delivered twice, and genuinely concurrently, exactly one "processed." |
| Replayed webhook (a legitimate but late delivery after the state already resolved via another channel) | VERIFIED (pre-existing) | Same file — "a webhook arriving for a withdrawal already resolved by a poll... is a correct, silent no-op." Strengthened this session with an explicit assertion that `custodyReference` and `txHash` remain distinct, never conflated (§5). |
| Stale worker (lease staleness) | VERIFIED (pre-existing) | `deposit-watcher-and-reconciliation.integration-spec.ts` — two concurrently-running watcher instances, only one acquires the lease; `DepositWatcherService.listCursorStatus()`'s `isLeaseStale`. |
| Worker restart during an in-flight poll | VERIFIED (pre-existing + Phase 16) | `deposit-watcher-and-reconciliation.integration-spec.ts`'s "restart/crash recovery" test (a scan failing partway releases the lease without advancing the cursor, the next scan resumes cleanly with no double-credit) — the DB-state half of this property. Phase 16's `deposit-watcher.service.spec.ts`/`withdrawal-watcher.service.spec.ts` graceful-shutdown tests plus `shutdown-hooks.spec.ts` — the process-lifecycle half (waits for the in-flight poll on shutdown, actually wired via `app.enableShutdownHooks()`). |
| Process shutdown during a financial operation | VERIFIED (pre-existing) | Not a new test — Postgres's own transaction atomicity means "the process was killed mid-transaction" and "the transaction threw and rolled back" are indistinguishable at the database level. The matching-failure and settlement-rollback tests cited above already prove no partial financial effect ever survives an aborted transaction, which is the actual property to prove; a literal `kill -9` mid-request would only re-demonstrate the same guarantee Postgres itself already provides. |
| Concurrent reconciliation | **VERIFIED — NEW THIS PHASE** | Only a *sequential* re-run test existed ("re-running a rescan... never creates a duplicate row"). Added a genuinely concurrent version to `independent-reconciliation.integration-spec.ts`: two independent `IndependentReconciliationService` instances (as two real worker processes would each construct) racing via `Promise.allSettled` to record the identical finding — proves the DB-level `@unique` constraint on `ReconciliationDiscrepancy.idempotencyKey` plus the code's catch-and-refetch-on-conflict path actually closes the real TOCTOU window between `findUnique` and `create`, not just against a mocked/serialized sequence. |
| Concurrent withdrawal state transition | VERIFIED (pre-existing) | `withdrawal-state-machine.integration-spec.ts` — approve/reject/fail/cancel races, 6 separate concurrent-race tests. |

## 4. Blockchain Watchers

**Status: PASS / VERIFIED — entirely pre-existing.** Mapped against
every property Phase 17 asked to audit:

| Property | Evidence |
|---|---|
| Idempotency | `deposit-idempotency.integration-spec.ts` (deposit crediting), `withdrawal-state-machine.integration-spec.ts` (confirmation recording). |
| Lease/concurrency behavior | `deposit-watcher-and-reconciliation.integration-spec.ts` — CAS lease, stale-lease reclaim; `withdrawal-watcher.service.ts`'s own docblock (Phase 16) documents and the code proves why withdrawals need no equivalent lease (status-guarded transactional updates already make duplicate effects impossible — see Phase 16's `docs/deployment-architecture.md` §3). |
| Bounded polling | `chainWatcher.pollIntervalMs`/`withdrawalWatcher.pollIntervalMs`, config-driven, off by default (`CHAIN_WATCHER_ENABLED`/`WITHDRAWAL_WATCHER_ENABLED`). |
| Retry/backoff | `retry.util.spec.ts`. |
| Reorg safety | `evm-deposit-adapter.spec.ts`'s "reorg-safety margin on cursor advancement" describe block — cursor advancement is bounded by `REORG_SAFETY_MARGIN_BLOCKS`, never advances into the reorg-risk zone at the chain tip. |
| Stale cursor handling | `deposit-watcher-and-reconciliation.integration-spec.ts`, `DepositsService.listStale`, `isScanStale`/`STALE_CURSOR_THRESHOLD_MS`. |
| Graceful shutdown | Phase 16's watcher `onModuleDestroy` tests + `shutdown-hooks.spec.ts` (this session re-confirmed both still pass, unmodified). |
| Duplicate event handling | `deposit-idempotency.integration-spec.ts` — "treats the same txHash with different eventIndex as distinct deposits (token-transfer safety)," concurrent duplicate observations. |
| Observability | `GET /admin/watchers`, `GET /admin/watchers/withdrawals`, `GET /health/ready` (Phase 16) — all re-verified working this session. |

No blockchain semantics were invented this phase — every check above
reuses the existing chain adapters and documented policies exactly as
Phase 17's instructions required.

## 5. Custody Boundary

**Status: PASS / VERIFIED for every code-level property; BLOCKED BY
EXTERNAL DEPENDENCY for live-provider verification.**

Walked the full path (request → compliance → reservation → approval →
executor → provider response → webhook/poll → confirmation →
reconciliation → final ledger state) against the actual code:

| Property | Status | Evidence |
|---|---|---|
| Production cannot use `ManualBroadcastExecutor` | VERIFIED (pre-existing) | `withdrawal-executor.factory.spec.ts` — "refuses to fall back to manual broadcast in production when no PRODUCTION_CUSTODY config exists," even with a MANUAL_BROADCAST config row present. |
| Sandbox cannot accidentally use production provider configuration | VERIFIED (pre-existing) | `withdrawal-executor.factory.spec.ts`'s environment-matching describe block — 6 explicit ALLOWS/REJECTS cases; `provider-config.integration-spec.ts`'s Phase 14B.1 §7 describe block, real Postgres. |
| `providerReference` and blockchain `txHash` remain distinct | **VERIFIED — strengthened this phase** | Distinct DB columns (`custodyReference` vs `txHash`) by design; `fireblocks-webhook.integration-spec.ts`'s first test now explicitly asserts both values after a real webhook-driven broadcast, and that they're never equal. |
| Ambiguous provider responses never incorrectly become successful broadcasts | VERIFIED (pre-existing) | `fireblocks-custody.adapter.spec.ts` — ambiguous is its own third outcome, distinct from both success and throw; `WithdrawalsService`'s `EXECUTION_AMBIGUOUS` state requires explicit SUPER_ADMIN resolution (`resolve-ambiguous-execution`), never auto-resolved. |
| Provider rejection after broadcast cannot release funds incorrectly | VERIFIED (pre-existing) | `fireblocks-webhook.integration-spec.ts`'s B1 describe block (§3 above). |
| Unsupported asset/network combinations fail closed | VERIFIED (pre-existing) | `withdrawal-executor.factory.spec.ts` — "rejects when the resolved executor declares it does not support this asset/network"; `provider-capability-matrix.spec.ts`. |
| A real Fireblocks sandbox actually behaves as these mocks assume | **BLOCKED BY EXTERNAL DEPENDENCY** | Explicitly deferred/optional per this phase's own instructions — no live Fireblocks sandbox credentials exist in this environment, and none were provisioned. This remains the single largest unverified assumption in the entire custody path: every test above proves VerdictVaut's *own* code behaves correctly against its *modeled* understanding of Fireblocks' API contract, not that the real API actually matches that model. |

## 6. Compliance Boundary

**Status: PASS / VERIFIED — entirely pre-existing.**

| Property | Evidence |
|---|---|
| Missing KYC blocks production | `production-safety.gate.spec.ts` — "still refuses production without an enabled KYC ComplianceProviderConfig." |
| Missing sanctions/KYT blocks production | Same file — the matching SANCTIONS_KYT check, tested independently. |
| Deferred compliance remains explicitly deferred | `deferred-compliance-gate.spec.ts` — "always reports DEFERRED (never PASS or BLOCKED)"; `compliance-gate.factory.spec.ts` — "in production, ALWAYS uses DeferredComplianceGate, regardless of any Elliptic config." |
| Compliance errors fail closed | `elliptic-address-risk.gate.spec.ts` — "never crashes, and never silently passes, when the Elliptic call itself fails"; "reports ERROR (not a guessed tier) when risk thresholds are not configured." |
| Address-risk screening cannot silently become an approval | Same file — "defers (never auto-passes) on a LOW risk score, still recording the signal." There is no code path anywhere that turns a compliance signal into an automatic PASS. |
| No UI/API claims legal compliance that isn't implemented | Reviewed `apps/web` for any compliance-related copy — none found claiming KYC/AML/sanctions screening is complete or certified; `DeferredComplianceGate`'s own name and every audit log entry it produces say `DEFERRED`, never a false claim of clearance. |

`production-safety.gate.spec.ts` also covers the positive case — "allows
production bootstrap once compliance AND custody configuration are
both genuinely complete" — proving the gate isn't just permanently
stuck refusing everything, but genuinely conditional on real
configuration.

## 7. Database & Migrations

**Status: PASS / VERIFIED, 2 new gaps closed.**

| Control | Status | Evidence |
|---|---|---|
| Destructive migration guard behavior | **VERIFIED — NEW THIS PHASE** | `scripts/guard-destructive-migration.js` (Phase 16) had never been covered by an automated test — only manually exercised via ad-hoc shell commands. Added `test/integration/guard-destructive-migration.integration-spec.ts`: spawns the real script as a real child process (it always calls `process.exit()`, so it can't be `require()`d directly into a test) across 6 cases — allows when neither env var is production, allows when both are unset, refuses on `APP_ENVIRONMENT=production`, refuses on `NODE_ENV=production`, refuses case-insensitively, and — the important negative case — **does not** refuse merely because `DATABASE_URL` looks exactly like a real production connection string, proving the documented limitation (Phase 16 review finding M3) as a living regression test rather than only prose. |
| Production `DATABASE_URL`/environment mismatch safeguards | VERIFIED (pre-existing) + documented limitation confirmed | `database-tls.validator.spec.ts` + `env.validation.spec.ts` cover the boot-time half (production refuses to boot without TLS-enforced `DATABASE_URL`). The migration-guard half's real limitation (env-var names checked, not `DATABASE_URL`'s value) is now a named, tested boundary (above), not just documentation. |
| Migrations are deterministic | VERIFIED (pre-existing) | Every integration test run applies the full committed migration history fresh against a new `embedded-postgres` instance (`test/integration/global-setup.js`) — this session's own test runs (23 suites, 225 tests) are themselves a fresh, successful application of all 21+ migrations. |
| Transaction isolation assumptions | VERIFIED (pre-existing) | `ledger-concurrency.integration-spec.ts`'s own title: "Ledger transaction isolation under concurrency (real Postgres, SERIALIZABLE)." |
| Indexes/constraints protecting financial invariants | VERIFIED (pre-existing) | `database-constraints.integration-spec.ts`, `trading-database-constraints.integration-spec.ts`, `settlement-database-constraints.integration-spec.ts` — CHECK constraints on non-negative amounts/balances, `@unique` idempotency keys, FK integrity, all exercised via direct raw-SQL-level attempts, not just through application code. |
| Backup/restore tooling, throwaway Postgres only | VERIFIED (pre-existing, Phase 12A) | `apps/api/scripts/backup-restore-drill.js` — a real backup/restore drill against `embedded-postgres`, documented in full (including its honest "what this does NOT prove" section) in `docs/database-backup-recovery.md` §6. Not re-run this session (no code changed in that path) — its prior PASSED result stands, verified by reading the doc's own recorded output, not re-claimed from memory. |
| No production database touched | VERIFIED | Confirmed throughout — every test this phase added uses either `embedded-postgres` (via the existing integration harness) or a subprocess with no `DATABASE_URL` pointed at anything real. |

## 8. API Security

**Status: mostly PASS / VERIFIED against existing controls; NOT
EXECUTED for anything requiring a live HTTP request (see §1's
supertest note).**

| Control | Status | Evidence |
|---|---|---|
| Rate limiting | VERIFIED (config-level) | `ThrottlerModule` global default (100/min) + `TRADING_THROTTLE`/`WITHDRAWAL_REQUEST_THROTTLE`/`ADMIN_MUTATION_THROTTLE`/`PROVIDER_WEBHOOK_THROTTLE` (`common/throttle-presets.ts`) applied per-route. **NOT EXECUTED**: no automated test proves a request is actually rejected once a limit is hit (would need a live HTTP harness). |
| Request validation | VERIFIED | `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` globally — unknown/extra fields are rejected, not silently dropped or accepted. Every DTO uses `class-validator` decorators, exercised indirectly through every service-level test that constructs a DTO object. |
| Payload size limits | **Reviewed — no explicit override found.** `main.ts` never configures Express's body-parser limit; NestJS/Express's own default (100kb JSON) applies. This is a reasonable, safe default, but it is implicit rather than an explicit, intentional, documented choice. Recorded as a LOW finding — worth an explicit `bodyParser.json({ limit: ... })` call for a real production deployment, not urgent. |
| HTTP security headers | VERIFIED (config-level) | `helmet({ contentSecurityPolicy: false })` — the CSP omission is a deliberate, documented choice (this API serves no browser-rendered HTML of its own), not an oversight. **NOT EXECUTED**: no test asserts the actual response headers a real request receives. |
| CORS | VERIFIED (config-level) | Wide open only in `NODE_ENV=development`; fails closed to an explicit, empty-by-default allowlist everywhere else. **NOT EXECUTED**: no test asserts actual preflight/response behavior. |
| Error redaction | VERIFIED (pre-existing) | `AllExceptionsFilter` (reviewed) + `redact.util.spec.ts` — every log line passes through `redactSensitiveFields` regardless of call site. |
| Request IDs | VERIFIED (pre-existing) | `request-id.middleware.spec.ts`, `request-context.spec.ts`. |
| Log redaction (passwords/JWTs/secrets) | VERIFIED (pre-existing) | `redact.util.spec.ts` — pattern `password\|secret\|token\|jwt\|privatekey\|private_key\|mnemonic\|seed\|authorization\|cookie\|apikey\|api_key` (case-insensitive), recursively applied, depth-bounded. |
| Admin endpoint authorization | **VERIFIED — NEW THIS PHASE** | See §1's decorator-audit test. |
| Sensitive info leakage via health/readiness endpoints | VERIFIED (Phase 16 review + re-confirmed) | `GET /health`/`GET /health/ready` return only booleans/counts/timestamps — no provider configuration, no secret values, no hostnames on the happy path. The one pre-existing nuance (an unreachable-DB error `.message` is included in the 503 body, which could theoretically echo an internal hostname) predates this phase and is unchanged; recorded again here as a standing LOW observation, not a new finding. |

## 9. Container / CI Security

**Status: reviewed (code-level); Docker daemon validation NOT
EXECUTED — Docker is unavailable in this environment (confirmed this
session: `docker --version` → command not found), same as every prior
phase.**

| Control | Status |
|---|---|
| Multi-stage Docker builds, non-root execution (`USER node`) | VERIFIED by reading `apps/api/Dockerfile`/`apps/web/Dockerfile` — unchanged since Phase 16, not modified this phase. |
| Runtime dependency minimization (`npm prune --omit=dev`) | Reviewed — unchanged since Phase 16's own review finding M2, which added a CI boot-smoke-test specifically because this couldn't be verified locally. That CI job (`docker-build`, GitHub Actions) is the actual verification point; it runs on GitHub's runners, not here. |
| Secret exposure in images | VERIFIED by reading — no secret literal anywhere in either Dockerfile; every credential is supplied at container run time only. |
| `.dockerignore` coverage | VERIFIED by reading — `.env*`, `infra/backups`, `*.log`, `.git`, `node_modules`, build artifacts all excluded. |
| CI permissions | VERIFIED by reading `.github/workflows/ci.yml` — no `permissions:` block is declared (inherits the repository/org default, typically read-only `GITHUB_TOKEN`); no job ever authenticates to a registry or pushes an image. |
| Dependency installation | VERIFIED — `npm ci` (lockfile-exact, not `npm install`) throughout CI. |
| Build artifacts | VERIFIED — `dist/` excluded from `.dockerignore`'s source copy is irrelevant (it's generated fresh inside the build stage); nothing checked into git ships a stale build artifact. |
| Migration execution | VERIFIED by reading both Dockerfile `CMD`s — migrations are deliberately never run at container startup (documented in-file); `prisma migrate deploy` is a separate, single-instance step. |
| **Actually running `docker build`/`docker run` here** | **NOT EXECUTED** — no Docker daemon available in this session. This matches every prior phase's own disclosure; CI (`docker-build` job, added Phase 16, includes a real boot + `/health`/`/health/ready` smoke test since the M2 review fix) is where this is actually exercised, on GitHub's infrastructure, not locally. |

## 10. Observability

**Status: PASS / VERIFIED for signal existence (all pre-existing);
alert *delivery* remains NOT EXECUTED (no vendor connected, by design
— see `docs/observability-and-alerting.md`).**

| Signal | Exists? |
|---|---|
| API health | `GET /health` |
| Database health | `GET /health/ready` (`checks.database`) |
| Worker health | `scripts/worker-healthcheck.js` (heartbeat file) + `GET /admin/watchers/withdrawals` |
| Stale blockchain cursors | `GET /health/ready` (`checks.blockchainWatchers`), `GET /admin/watchers` |
| Failed polls | `wallet.deposit_watcher.scan_failed`, `wallet.withdrawal_watcher.poll_failed`/`confirmation_check_failed`/`provider_check_failed` metrics |
| Provider failures | `provider_request_failures_total`, `provider_ambiguous_operations_total` |
| Reconciliation discrepancies | `wallet.reconciliation.discrepancy_found`, `settlement.collateral_reconciliation.discrepancy_found`, `GET /admin/reconciliation/discrepancies` |
| Failed withdrawals | `wallet.withdrawal_watcher.marked_failed`, `wallet.withdrawal.execution_ambiguous` |
| Repeated authentication failures | `AuthService.login`'s failure-count tracking (`login-throttle.util.ts`) + every failed attempt audit-logged (`auth.service.spec.ts`) |

**Log redaction re-verified**: `redact.util.spec.ts`'s pattern
explicitly covers passwords, JWTs, API keys, private keys, and the
generic `secret`/`token`/`authorization`/`cookie` family — which
catches webhook secrets and database credentials by name pattern
(anything with `secret`, `password`, `token`, `authorization` in its
key) without needing a separate, narrower pattern for each. Sensitive
provider payloads (a raw Fireblocks/Elliptic response body) pass
through the same universal redaction if ever logged — no call site is
exempt.

## 11. Load / Concurrency Validation

Per this phase's own instruction, no uncontrolled load test was run.
Every item on the requested list is a **bounded, deterministic**
concurrency test (small fixed number of real concurrent operations via
`Promise.all`/`Promise.allSettled` against real Postgres, not a
generated load pattern):

| Scenario | Result |
|---|---|
| Duplicate deposit event | PASS (pre-existing) — `deposit-idempotency.integration-spec.ts`: credited exactly once under concurrent duplicate observations. |
| Duplicate withdrawal webhook | PASS (pre-existing) — `fireblocks-webhook.integration-spec.ts`: exactly one "processed", one "duplicate". |
| Concurrent withdrawal transition | PASS (pre-existing) — `withdrawal-state-machine.integration-spec.ts`: 6 separate races (cancel, approve, reject, fail, approve-vs-reject, duplicate confirmation), each resolving to exactly one winner. |
| Concurrent order cancellation/matching | PASS (pre-existing) — `order-cancellation.integration-spec.ts` + `matching-execution.integration-spec.ts`'s `concurrency` block (2 races: duplicate `matchAndExecute`, several takers competing for one resting order). |
| Concurrent settlement | PASS (pre-existing) — `resolution-settlement.integration-spec.ts`: 3 simultaneous `settleMarket` calls, every position credited exactly once, `PositionSettlement` count exactly matches winner count. |
| Concurrent reconciliation | **PASS — NEW THIS PHASE** — `independent-reconciliation.integration-spec.ts`: 2 independent service instances racing `runIndependentRescan` against the identical finding, exactly one discrepancy row, neither racer's promise rejects. |

Every result above was actually run this session (not assumed from a
prior phase's report) as part of the full `npm run test:integration`
pass — see §14 for exact counts.

## 12. Production Readiness Gate

**Status: reviewed, unmodified.** `apps/api/scripts/production-readiness-check.js`
was run this session (no `--with-db`, matching this environment's lack
of a reachable database):

```
Summary: 13/20 passed
P0 (blocks any production financial activity): 6
P1 (blocks production launch): 1
P2 (should fix shortly after launch): 0
BLOCKED
```

The 6 P0 failures (`DATABASE_URL`/JWT secrets not set in this shell —
expected in a dev sandbox with no `.env`; production custody not
integrated; production compliance not integrated) and the 1 P1 failure
(no managed backup/HA/PITR/off-site storage decision) are **identical
in kind** to every prior phase's report — none was invented, none was
suppressed, and this file was **not edited** this phase. Phase 17's
own work (test coverage, not new deployable infrastructure) has no
natural file-presence check to add to this script the way Phase 16's
new Dockerfiles/CI jobs/worker process did — adding a check like "the
admin-authorization audit test exists" would only prove a file's
existence, not that the underlying property actually holds, which
would be exactly the kind of hollow check this tool's own design
principle (`SEVERITY` classification + "never allowed to pass just
because it wasn't checked") argues against. The gate continues to
correctly report BLOCKED.

## 13. Documentation

This document is the Phase 17 deliverable for the documentation
requirement itself. Cross-references:

- `docs/deployment-architecture.md`, `docs/production-database-requirements.md`,
  `docs/observability-and-alerting.md`, `docs/operations-runbook.md`
  (Phase 16) — unchanged this phase, still accurate.
- `docs/database-backup-recovery.md` (Phase 12A), `docs/provider-integration.md`
  (Phase 14B), `docs/fireblocks-sandbox-smoke-test.md` (Phase 14B.1) —
  unchanged, still the authoritative source for what a real staging
  deployment and a real Fireblocks sandbox verification actually
  require.

**Controls requiring staging** (cannot be verified further without a
persistent, externally-reachable Postgres — never provisioned in any
session that has worked on this repository):
- A real end-to-end deploy of the split API/worker/web images.
- `staging-preflight-check.js` actually reporting all-clear against a
  real staging database.

**Controls requiring real provider verification** (explicitly optional/
deferred per this phase's instructions):
- A live Fireblocks sandbox smoke test — see
  `docs/fireblocks-sandbox-smoke-test.md` for the exact prerequisite
  checklist; still not attempted, by design.
- A live Elliptic sandbox call actually classifying a known address.

**Known production blockers** (unchanged from Phase 16's own report):
1. No real production custody provider.
2. No real production compliance provider.
3. No managed-provider/self-hosted HA backup strategy, WAL archiving,
   or off-site encrypted storage decision.
4. Docker images built but never boot-tested against a real Docker
   daemon by a human (CI does this automatically now — a local
   confirmation still hasn't happened in any session).
5. Fiat on/off-ramp — out of scope, unstarted.

**Exact next steps for a future staging deployment** (unchanged, see
`docs/operations-runbook.md` §1 for the full procedure): provision a
persistent external Postgres; set `APP_ENVIRONMENT=sandbox` with real
secrets; run `prisma migrate deploy` once; deploy API/worker/web images
per `docs/deployment-architecture.md`; run `staging-preflight-check.js`;
only then consider a live Fireblocks sandbox smoke test.

## 14. Testing — exact counts, this session

| Suite | Before Phase 17 | After Phase 17 | New |
|---|---|---|---|
| API unit tests (suites / tests) | 73 / 685 | 74 / 720 | +1 suite, +35 tests |
| API integration tests (suites / tests) | 22 / 218 | 23 / 225 | +1 suite, +7 tests |
| Web tests | 40 / 206 | 40 / 206 | unchanged (no web code touched) |

New test breakdown (39 new test cases total): 4 `AuthService.logout()`
tests, 31 `AdminController` authorization-decorator audit tests
(dynamically generated — see §1), 6 `guard-destructive-migration.js`
subprocess tests, 1 concurrent-reconciliation race test, plus 1
strengthened assertion (not a new test) in the existing Fireblocks
webhook `txHash`/`custodyReference` distinctness check.

Typecheck, lint, build (all 3 workspaces), `prisma validate`, and
`git diff --check` were all run clean — see the final report for the
literal command output.
