# Staging Deployment & End-to-End Validation — Phase 18

A real staging deployment of VerdictVaut was actually built and driven
end-to-end this phase — not simulated, not described hypothetically.
Docker was unavailable (confirmed again this session), so the stack was
run as real OS processes against a real, persistent (for the session)
PostgreSQL instance, with real HTTP requests issued against the running
API and web servers via `curl`. Every claim below is either something
this phase directly observed happen, or is explicitly marked otherwise.

**The single most important result of this phase is a genuine, previously
undiscovered CRITICAL functional defect — see §0.**

## 0. CRITICAL FINDING — newly registered users can never become usable

`User.status` defaults to `PENDING_VERIFICATION` in `prisma/schema.prisma`
(`@default(PENDING_VERIFICATION)`). `AuthService.register()` — the real
code behind the real `POST /auth/register` endpoint — creates the user
with no `status` field, so every real registration lands in
`PENDING_VERIFICATION`. A full repository search found **no code path
anywhere** that ever transitions a user out of it: no email-verification
endpoint, no admin user-activation endpoint (`UsersController` only has
two `GET` routes; `AdminController` has no user-management routes at
all), nothing. `RolesGuard` requires `status === ACTIVE` for **any**
role-gated route (so even a legitimately-promoted `SUPER_ADMIN` stays
blocked); `OrdersService`/`WithdrawalsService` both separately enforce
the same check for trading/withdrawals.

**Practical effect: a real user who registers through the real, public
API — in staging or in a hypothetical production deployment exactly as
this code stands today — can never log into any role-gated route, trade,
or withdraw.** This is fail-closed (never a security hole), but it means
the product is non-functional end-to-end for real users out of the box.

**Why 225+ integration tests across 17 phases never caught this**:
`test/integration/helpers.ts`'s `createTestUser()` defaults its `status`
parameter to `"ACTIVE"` and creates users directly via Prisma, entirely
bypassing the real `AuthService.register()` code path every one of those
tests implicitly assumed was equivalent. This is exactly the class of
gap only a genuine end-to-end test through the real HTTP registration
flow — which nothing in this repository had done before this phase —
can surface.

**How this phase worked around it to continue validating everything
else**: test accounts' `status` was set to `ACTIVE` via a direct,
explicitly-logged `UPDATE users SET status = 'ACTIVE' ...` against the
throwaway staging database, after registering them through the real
`/auth/register` endpoint. This is **not** a legitimate application flow
and is not how any real user could ever become active today — it is
recorded here as a manual bug-workaround for continued testing, not
presented as a working feature. It also is not a privilege-escalation
bypass: it activates an account to the same USER-level access a verified
account would have, never grants a role beyond what was separately,
explicitly set (see §6).

**Fix recommendation (not implemented this phase — a functional bug fix
is out of this phase's scope, which is validation)**: implement email
verification (or, at minimum for a real staging/demo environment, an
explicit SUPER_ADMIN "activate user" endpoint), or change the default to
`ACTIVE` if this application deliberately has no verification
requirement — but that would need equal review of whether
`PENDING_VERIFICATION`'s existence elsewhere (checked in 4 places) was
protecting against something real.

## 1. Staging architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Next.js web │────▶│   NestJS API      │────▶│   PostgreSQL     │
│  (port 4300) │     │   (port 4100)     │     │   (port 55432)   │
└─────────────┘     └──────────────────┘     └────────┬────────┘
                     ┌──────────────────┐              │
                     │ Background worker │──────────────┘
                     │ (no HTTP port)    │
                     └──────────────────┘
```

Four independent OS processes, exactly matching
`docs/deployment-architecture.md`'s design:

| Process | Command actually run | Port |
|---|---|---|
| PostgreSQL | `embedded-postgres` (same package the test harness uses), `initdb` + `pg_ctl start` under the hood, data dir under this session's scratchpad | 55432 |
| API | `node dist/main.js` | 4100 |
| Worker | `node dist/worker.main.js` | none (heartbeat file only) |
| Web | `node apps/web/.next/standalone/apps/web/server.js` (with `.next/static` copied in — see §3) | 4300 |

## 2. Environment / configuration (no secret values)

All four processes were started with `APP_ENVIRONMENT=sandbox`
explicitly set. `env.validation.ts`'s unconditional refusal of
`APP_ENVIRONMENT=production` (unchanged, re-confirmed by reading the
current source) means **production configuration cannot be accidentally
selected** — there is no environment-variable combination that would
have made this staging run boot as production.

| Variable | Purpose | Value class |
|---|---|---|
| `NODE_ENV` | `production` (matches what the Dockerfiles set) | non-secret |
| `APP_ENVIRONMENT` | `sandbox` (required) | non-secret |
| `PORT` | 4100 (API) / 4300 (web) | non-secret |
| `DATABASE_URL` | points at the local throwaway staging Postgres above | **connection string — contains a locally-generated password used nowhere else; never printed in this document** |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | 48-char locally-generated placeholder strings, distinct from each other | **secret — value never printed; only its length (48) and that the two differ were checked** |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:4300` | non-secret |
| `CHAIN_WATCHER_ENABLED` / `WITHDRAWAL_WATCHER_ENABLED` | `false` on the API process, `true` on the worker process only | non-secret |
| `WORKER_HEARTBEAT_FILE` / `WORKER_HEARTBEAT_INTERVAL_MS` | scratchpad path / 3000 | non-secret |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4100` | non-secret (baked into the client bundle by design) |

No `.env` file was created or committed; every value above was passed
as a process environment variable for this session only and is gone
with the processes.

## 3. Container deployment

**Status: NOT EXECUTED.** `docker --version` → `command not found`,
confirmed again this session — Docker remains unavailable in this
environment across Phase 15, 16, 17, and now 18. Every non-Docker
staging validation possible was run instead (§4–§13).

One concrete, valuable finding surfaced by running the REAL Docker-
equivalent web startup command locally (see below), which would not
have been caught by `docker build` alone even if Docker were available,
since it's about the runtime command, not the image build:

**`npm run start` (apps/web's own package.json script, i.e. `next
start`) is NOT the correct command for this app's actual deployment
target.** Phase 16 added `output: "standalone"` to `next.config.mjs`
for the Docker image. Running `next start` against a standalone build
now prints: `"next start" does not work with "output: standalone"
configuration. Use "node .next/standalone/server.js" instead.` It still
returned HTTP 200 for the homepage in this test, but this is an
unsupported, warned-against configuration — not something to rely on.
The **correct** command — exactly what `apps/web/Dockerfile`'s `CMD`
actually runs — was verified separately and works perfectly: copy
`.next/static` into `.next/standalone/apps/web/.next/static` (the
Dockerfile does this via its own `COPY` instructions), then
`node apps/web/server.js` from inside `.next/standalone`. Both the
homepage and a static CSS asset returned 200 via this path.
**Recommendation**: either remove/relabel apps/web's `"start"` script
(it no longer reflects how this app is actually deployed) or leave it
documented as dev-only, distinct from the real deployment command.

## 4. API / web end-to-end results

All driven via real `curl` requests against the running staging API
(port 4100), using only data created through the real API or, where
noted, direct SQL for non-financial configuration/bootstrap data (see
§0 and §6 for exactly which SQL statements were run and why).

| Step | Result |
|---|---|
| Register a test user | PASS — real `201`, real JWT pair issued |
| Duplicate registration (same email) | PASS — real `409`, confirmed via DB that no second row was created |
| Authenticate (login) | PASS |
| Session behavior: refresh rotates the token | PASS — old refresh token stops working after rotation |
| Session behavior: logout invalidates the session | PASS — a `refresh()` call with the just-logged-out token is rejected (`401`) — the very first real end-to-end proof of this in the repository's history |
| View wallet | PASS — real, legitimately-zero balances for all 6 seeded assets |
| View markets | PASS — real `[]` before creating one, real listing after |
| View order book | PASS — real `{bids:[],asks:[]}` |
| Create a legitimate test order | **PARTIAL** — a real order submission was sent to the real endpoint and correctly rejected with `400 Insufficient available balance` (see §5) |
| Successful order + reservation + cancellation | **NOT EXECUTED** — see §5 for why, and why it could not be worked around |
| Cross-user IDOR check | PASS — a second user attempting to revoke the first user's session got a real `404`, and the DB confirms the session was genuinely untouched |

Web: homepage, `/login`, `/register`, `/markets` all returned real `200`
responses from the actual running Next.js server.

## 5. Financial safety results

**Why a funded order flow could not be tested**: creating a real balance
requires either (a) a real observed blockchain deposit — blocked, no
live testnet access was available and none was fabricated, per this
phase's explicit instructions — or (b) directly writing a ledger credit,
which is exactly what "do not create fake monetary deposits" forbids.
Neither is legitimate. What **was** proven, live, against the real
database:

| Property | Result |
|---|---|
| An order attempt with zero real balance is rejected, not partially applied | PASS — `400`, and a direct DB query confirmed `orders`, `fund_reservations`, and `ledger_entries` all remained at exactly 0 rows after the attempt |
| `financial-integrity-checks.js` against live staging | PASS — 8/8 checks, run for real against the staging database (not the test harness's embedded instance) |
| No negative balances | PASS (trivially, but genuinely checked — 0 violations reported) |
| Duplicate request idempotency | PASS — duplicate registration (same email) confirmed idempotent at the database level |
| No unauthorized financial mutation | PASS — the IDOR session-revoke test (§4) and the authorization tests (§6) are the concrete proof; no admin financial-mutation endpoint was reachable by a non-SUPER_ADMIN token in any attempt made |

## 6. Admin / authorization results

A `SUPER_ADMIN` test account was created the only way currently possible
in this codebase: register through the real API, then promote via
`UPDATE users SET role = 'SUPER_ADMIN' WHERE email = ...`. **This
repository has no admin-bootstrap tooling of any kind** (no CLI command,
no seed-time super-admin, no first-run wizard) — this is a genuine,
separate finding worth fixing before any real deployment needs an
initial administrator. The SQL above only ever sets `role`, never
`status` — status activation (§0) was a separate, explicitly-logged
step.

| Check | Result |
|---|---|
| Plain `USER` hitting a `SUPER_ADMIN`-gated endpoint (`GET /admin/watchers`) | PASS — real `403` |
| Unauthenticated request to the same endpoint | PASS — real `401` |
| `SUPER_ADMIN` hitting the same endpoint | PASS — real `200` |
| Plain `USER` attempting a `SUPER_ADMIN` mutation (`POST /admin/withdrawals/:id/approve`) | PASS — real `403` |
| `SUPER_ADMIN` reading watcher/reconciliation endpoints | PASS — `GET /admin/watchers`, `GET /admin/watchers/withdrawals`, `GET /admin/reconciliation/discrepancies` all real `200` |
| Cross-user private data access | PASS — see §4's IDOR result |

No elevated privilege was ever granted through an undocumented bypass —
every role/status change made was a direct, explicit, logged SQL
statement against this session's own throwaway database, done because
this codebase currently has no application-level path to reach that
state at all (§0, and the admin-bootstrap gap above).

## 7. Worker results

The worker ran as a fully separate OS process (no HTTP port bound),
started via `node dist/worker.main.js`, continuously for the duration of
this entire phase (~20+ minutes) without crashing or needing manual
intervention.

| Check | Result |
|---|---|
| Startup | PASS — clean boot, structured JSON logs, both watchers started |
| Heartbeat | PASS — `WORKER_HEARTBEAT_FILE` updated every ~3s throughout; `scripts/worker-healthcheck.js` run against it returned exit 0 |
| Restart | PASS — process was stopped and a fresh one started; heartbeat resumed cleanly within seconds, no stuck state |
| Graceful shutdown (real OS signal) | **NOT EXECUTED — genuine platform limitation, not a code defect.** Windows has no real POSIX signal delivery; `process.kill(pid, 'SIGTERM'/'SIGINT')` from a separate Node process on Windows does not reliably invoke the target's registered signal handler — Node's own documentation states cross-process `process.kill()` on Windows "merely terminates the target process." Confirmed empirically: the worker exited with code 1 (abrupt) rather than logging its own "shutting down gracefully" message. The actual deployment target is Linux containers (`node:20-alpine`), where SIGTERM/SIGINT are real signals and this works as designed — proven at the unit level by Phase 16's `shutdown-hooks.spec.ts` (re-run this phase, still passing), which simulates the real Nest shutdown-hook code path without relying on OS signal delivery. |
| Lease/concurrency behavior | Not newly exercised this phase (no deposit addresses were provisioned — see below) — already proven by real-Postgres tests in `deposit-watcher-and-reconciliation.integration-spec.ts` (Phase 8–17), re-run clean this phase. |
| No duplicate financial processing | PASS (by absence of any financial activity to duplicate, plus the pre-existing test suite) |
| Stale worker detection | Not newly exercised (no lease was ever held — no addresses to scan) |
| Retry/backoff behavior | PASS — during the real database-interruption test (§13), the worker's own retry/backoff and per-poll error handling were directly observed live (see §13) |
| Database interruption resilience | PASS — see §13 |

**Why no real chain-scanning activity happened**: `CHAIN_WATCHER_ENABLED=true`
was genuinely set, and the deposit watcher genuinely polled every 5s —
but `DepositWatcherService.scanOne` returns immediately, before any RPC
call, when an asset/network has no assigned deposit addresses
(`loadWatchedAddresses` returns empty). No deposit addresses were
provisioned this phase (doing so meaningfully would require exercising
the deposit flow, which circles back to §0/§5's funding constraint), so
the watcher ran continuously and safely without ever attempting a real
outbound RPC call — confirmed by the complete absence of any RPC-related
log line across the entire session.

## 8. Blockchain infrastructure results

**Status: configuration/fail-safe behavior VERIFIED; live chain
detection NOT EXECUTED (no testnet transaction available).**

- Chain adapter configuration (RPC URL fallback to public testnet
  endpoints, per-asset-network resolution) was reviewed against the
  running worker's actual environment — unchanged from Phase 8–17,
  confirmed still current by reading `rpc-config.service.ts`.
- Fail-safe behavior: proven live via the database-interruption test
  (§13) — a real failure (DB unreachable, analogous in effect to an RPC
  failure hitting the same per-poll try/catch) was caught, logged
  structurally, metriced, and never crashed the process.
- Cursor/lease persistence: `BlockchainWatchCursor` table exists,
  schema/constraints re-verified via `prisma migrate deploy` +
  `financial-integrity-checks.js` against the live staging DB; no
  cursor rows exist yet (nothing has been scanned — see §7).
- **No real testnet/sandbox blockchain transaction was observed or
  fabricated this phase.** Reorg safety, real confirmation-count
  behavior, and genuine chain-adapter HTTP behavior remain
  BLOCKED BY EXTERNAL DEPENDENCY (no live testnet RPC credentials
  configured) — already proven at the mocked-adapter unit level
  (`evm-deposit-adapter.spec.ts`'s reorg-safety-margin tests, re-run
  clean this phase), never claimed as live-verified.

## 9. Custody results

**Status: PASS for every property checkable without a real provider;
BLOCKED BY EXTERNAL DEPENDENCY for anything requiring a real Fireblocks
sandbox call (none was attempted, per this phase's explicit
instructions).**

- `ManualBroadcastExecutor` sandbox-only, production fail-closed custody,
  provider-environment mismatch rejection, unsupported asset/network
  fail-closed: all re-confirmed by re-running
  `withdrawal-executor.factory.spec.ts` and `provider-config.integration-spec.ts`
  against the live staging DB context (via `npm run test:integration`)
  — unchanged, all passing.
- `providerReference`/`txHash` distinctness: re-confirmed by reading the
  schema (`custodyReference` vs `txHash`, separate columns) — same
  property Phase 17 added a live-Postgres assertion for.
- **No withdrawal was executed** — correctly so, since no legitimate
  sandbox provider is actually configured in this staging deployment
  (no real `CustodyProviderConfig` row was created; doing so with fake
  credentials would itself violate "do not invent provider responses").

## 10. Reconciliation results

All run live against the staging database via real `SUPER_ADMIN`-
authenticated HTTP requests:

| Check | Result |
|---|---|
| Clean state produces no discrepancy | PASS — `GET /admin/reconciliation/discrepancies` → `[]`; `POST /admin/reconciliation/collateral/check-all` → `{checked:0, discrepanciesFound:0}` |
| Injected/test discrepancy detection | **NOT EXECUTED** — would require either a real deposit/withdrawal to diverge from (blocked, §0/§5) or fabricating chain/internal state disagreement, which the existing tooling's own design (`independent-reconciliation.integration-spec.ts`, Phase 11–17) already covers via safe fake-adapter fixtures at the test-suite level, not against a live staging deployment — re-run clean this phase as the substitute evidence. |
| Reconciliation does not mutate balances | PASS (by design, re-confirmed — the two calls above are read/audit-only, and the financial-integrity check before and after showed no change) |
| Discrepancy visible to authorized admin only | PASS — same authorization boundary as §6 |
| Concurrent reconciliation remains safe | PASS — two `POST /admin/reconciliation/collateral/check-all` requests fired genuinely concurrently (parallel `curl` processes) both returned `201` with no error, no crash |

## 11. Security results

All checked live, not just by reading configuration:

| Control | Result |
|---|---|
| TLS/database configuration boundary | Not directly exercisable in staging (`APP_ENVIRONMENT=sandbox` deliberately skips the TLS requirement) — the production-only enforcement path is unit-tested (`database-tls.validator.spec.ts`), re-run clean this phase, unchanged. |
| CORS | PASS — an allowed origin (`http://localhost:4300`) got `Access-Control-Allow-Origin` echoed back; a disallowed origin (`http://evil.example.com`) did not. |
| Security headers | PASS — real response headers captured: HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, and more — all from Helmet, live. |
| Rate limiting | PASS — 11 rapid real requests to `POST /auth/login`; the 11th returned real `429`, matching the configured 10/60s `AUTH_THROTTLE`. |
| Authentication | PASS — see §4. |
| Authorization | PASS — see §6. |
| Request IDs | PASS — every response observed this session carried a real `X-Request-Id` header and the same id in JSON error bodies. |
| Log redaction | PASS — grepped the complete API log output for every plaintext password and every issued JWT used this session: zero matches. Also grepped for the staging DB password: zero matches, in both API and worker logs. |
| Health endpoint information exposure | PASS with one confirmed pre-existing LOW nuance made concrete: `GET /health`/`GET /health/ready` never expose secrets, but the 503 body's database error message DID include the literal `localhost:55432` host:port during the live outage test (§13) — a real, now-directly-observed instance of the info-disclosure nuance already flagged in the Phase 16/17 reviews. Unauthenticated, but only host:port, never credentials. |

## 12. Observability results

| Signal | Result |
|---|---|
| API logs | PASS — structured JSON throughout, `X-Request-Id` correlated. |
| Worker logs | PASS — structured JSON, including real error entries with full stack traces during the DB-outage test. |
| Request IDs | PASS (§11). |
| Worker health | PASS (§7). |
| Watcher status | PASS — `GET /admin/watchers`, `GET /admin/watchers/withdrawals`, both real `200` (empty/idle, correctly reflecting no scan activity — see §7). |
| Readiness | PASS — both the healthy and the DB-down state were directly observed (§13). |
| Failure metrics/signals | PASS — `wallet.withdrawal_watcher.poll_failed` with an incrementing `consecutiveFailures` tag was directly observed in the real worker log stream during the DB outage. |
| External metrics/logging sink | **NOT EXECUTED** — no vendor is connected anywhere in this codebase, by design (`docs/observability-and-alerting.md`, unchanged). The provider-neutral boundary itself (`MetricsService`/`LoggingMetricsService`) was exercised live (every metric emission above went through it). |

## 13. Failure-injection results

| Test | Result |
|---|---|
| API restart | Implicitly covered — the API process was never killed unexpectedly during this session; its resilience to DB loss (below) is the more meaningful test actually performed. |
| Worker restart | PASS (§7). |
| Database connection interruption | **PASS — the strongest live result of this phase.** The real staging Postgres was cleanly stopped (`pg_ctl stop -m immediate`) while the API and worker were both live. Observed: `GET /health` stayed `200` (liveness correctly independent of DB state); `GET /health/ready` correctly returned `503` with a clear error; the worker's poll loop caught each failure individually, logged it structurally, incremented `consecutiveFailures` via the metrics boundary, and **never crashed**. Postgres was then restarted; the API's readiness recovered to `200` automatically with no process restart needed; the worker's heartbeat never stopped updating throughout. |
| Duplicate request | PASS — duplicate registration (§4/§5). |
| Duplicate webhook fixture | **NOT EXECUTED / BLOCKED BY EXTERNAL DEPENDENCY** — the real Fireblocks webhook endpoint requires a valid HMAC/RSA signature verified against real Fireblocks-issued key material; no real webhook secret is configured in this staging deployment (none was fabricated, per this phase's instructions), so no validly-signed payload could be constructed. The webhook-duplication *logic itself* remains proven at the real-Postgres integration-test level (`fireblocks-webhook.integration-spec.ts`, re-run clean this phase). |
| Concurrent state transition | PASS — concurrent reconciliation (§10); the authorization/IDOR tests (§4/§6) were also fired as genuinely independent real HTTP requests. |
| Provider unavailable | Not directly exercisable live (no real provider is configured in this staging deployment at all — see §9) — covered at the mocked-adapter level (`fireblocks-custody.adapter.spec.ts`, re-run clean). |
| RPC unavailable | Not directly exercisable live (no addresses are being watched — see §7) — the DB-interruption test above exercises the identical code path (a per-poll try/catch around an external I/O failure) that RPC unavailability would hit, with real, live evidence of correct behavior. |

**Financial state remained consistent throughout every failure
injected**: `financial-integrity-checks.js` was re-run after the DB
outage/recovery cycle and still reported 8/8 PASS.

## 14. Production safety

`node scripts/production-readiness-check.js --with-db` was run for the
first time ever against a genuinely reachable database (every prior
phase only had the DB-free checks available):

```
Summary: 21/24 passed
P0: 2   (production custody not integrated; production compliance not integrated)
P1: 1   (no managed backup/HA/PITR/off-site storage decision)
P2: 0
BLOCKED
```

The two new DB-dependent checks that only run with `--with-db`
(database reachability, non-native `AssetNetwork` contract-address
consistency) both **PASSED** — genuinely exercised against a real
database for the first time, not merely skipped. The script was not
modified. The result is correctly, honestly `BLOCKED` — identical in
kind to every prior phase's report; nothing was softened to produce a
better number.

## 15. Rollback procedure (staging)

Since this staging deployment is four independent local processes with
no orchestrator:

1. Stop the web process (`Stop-Process` on its PID, or Ctrl+C).
2. Stop the worker process the same way — its `onModuleDestroy`
   graceful-shutdown logic will run correctly under a real SIGTERM/
   SIGINT in the actual deployment target (Linux); on this Windows
   session it terminates abruptly (§7's documented limitation).
3. Stop the API process the same way.
4. `pg_ctl -D <data-dir> stop -m fast` for Postgres, or simply discard
   the throwaway data directory entirely (nothing here was ever meant
   to persist).
5. To roll back an *application* change: redeploy the previous image/
   commit for the affected process only — migrations are forward-only
   (`docs/operations-runbook.md` §3 already documents the full
   migration-rollback procedure; unchanged this phase).

## 16. Exact commands used (representative, secrets/paths redacted)

```bash
# Staging Postgres (embedded-postgres, throwaway)
node .tmp-staging-pg-start.js     # initialise + start + createDatabase

# Migrations — production-safe path
DATABASE_URL=postgresql://staging:***@localhost:55432/verdictvaut_staging \
  npx prisma migrate deploy
npx prisma migrate status
npx prisma db seed

# API (separate process, watchers OFF)
APP_ENVIRONMENT=sandbox PORT=4100 CHAIN_WATCHER_ENABLED=false \
  WITHDRAWAL_WATCHER_ENABLED=false node dist/main.js

# Worker (separate process, watchers ON)
APP_ENVIRONMENT=sandbox CHAIN_WATCHER_ENABLED=true \
  WITHDRAWAL_WATCHER_ENABLED=true node dist/worker.main.js

# Web (real Docker-equivalent path)
node apps/web/.next/standalone/apps/web/server.js

# E2E
curl -X POST http://localhost:4100/auth/register ...
curl -X POST http://localhost:4100/auth/login ...
curl http://localhost:4100/wallet/balances -H "Authorization: Bearer ..."
curl -X POST http://localhost:4100/markets ... (SUPER_ADMIN)
curl -X POST http://localhost:4100/trading/orders ...

# Financial/readiness verification
node scripts/financial-integrity-checks.js
node scripts/production-readiness-check.js --with-db

# Failure injection
pg_ctl -D <data-dir> stop -m immediate   # simulate DB outage
pg_ctl -D <data-dir> start               # recovery
```

## 17. Known external dependencies (unchanged, restated)

- A real Fireblocks sandbox account/credentials — never provisioned in
  any session; explicitly deferred again this phase.
- A real Elliptic sandbox account/credentials — same.
- A real, persistent, externally-reachable staging Postgres for an
  actual multi-day staging deployment (this phase's Postgres was
  genuinely real and persistent-for-the-session, but local and
  throwaway — not the "real staging database" a production rollout
  would eventually need).
- A real Docker daemon, anywhere — still never available in any
  session.
