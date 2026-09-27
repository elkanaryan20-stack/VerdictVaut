# Operations Runbook — Phase 16

Operational procedures for deploying, running, and recovering
VerdictVaut. Every section is explicitly marked:

- **READY FOR IMPLEMENTATION** — the tooling/commands exist and are
  correct as far as code review and unit tests can confirm, but the
  *procedure as a whole* has never been run against a real staging/
  production environment.
- **VERIFIED** — actually executed, with the result stated (per this
  repo's existing standard — see `docs/database-backup-recovery.md`
  §6's restore drill for the precedent this follows).

No section here invents a cloud provider, orchestrator, or specific
managed-database vendor — none is chosen anywhere in this repository.

## 1. Staging deployment

**Status: READY FOR IMPLEMENTATION.** `docs/fireblocks-sandbox-smoke-test.md`
already documents the fullest version of this; summarized here:

1. Provision a persistent external Postgres reachable from the
   deployment target (never provisioned in any session that built this
   repo — `staging-preflight-check.js` has always reported this
   missing).
2. Set `APP_ENVIRONMENT=sandbox`, a real `DATABASE_URL` (TLS strongly
   recommended even for staging), distinct 32+ char `JWT_ACCESS_SECRET`/
   `JWT_REFRESH_SECRET`, and `CORS_ALLOWED_ORIGINS` for the staging web
   origin.
3. Run `npm run prisma:migrate:deploy -w apps/api` once, as a single
   step, before starting any application replica (see
   `docs/production-database-requirements.md` §4).
4. Deploy the API image (`apps/api/Dockerfile`, default/`runtime`
   target) with `CHAIN_WATCHER_ENABLED`/`WITHDRAWAL_WATCHER_ENABLED`
   left `false` (or, for a genuine single-process staging setup only,
   `true` + `ALLOW_WATCHERS_IN_API_PROCESS=true`).
5. Deploy the worker image (`--target worker`) separately with those
   same flags set `true` — this is the only process that should have
   them on in a two-process deployment.
6. Deploy the web image with `NEXT_PUBLIC_API_URL` pointed at the
   staging API.
7. Run `node scripts/staging-preflight-check.js` (read-only) before
   attempting any real sandbox provider call.
8. Run `node scripts/production-readiness-check.js` — expect it to
   still report P0 failures for production custody/compliance; that's
   correct for staging (it's asking "is this safe for PRODUCTION").

## 2. Production deployment prerequisites

**Status: BLOCKED — do not attempt.** Every one of these is currently
false, by design (see `env.validation.ts`, which refuses to even boot
with `APP_ENVIRONMENT=production` today):

1. A real, tested production custody provider integration
   (`ProductionCustodyExecutor` still unconditionally throws).
2. A real, tested production KYC/AML/sanctions compliance provider
   (`ComplianceGateFactory` always forces `DeferredComplianceGate` in
   production regardless of configuration, by design).
3. Production database TLS + the requirements in
   `docs/production-database-requirements.md`.
4. Explicit RPO/RTO targets and the backup/WAL-archiving architecture
   to meet them (`docs/database-backup-recovery.md` §4/§7).
5. `docker build` actually verified against a real Docker daemon
   (reviewed, CI-validated per `.github/workflows/ci.yml`'s
   `docker-build` job, but never run in any interactive session that
   authored these Dockerfiles — Docker has been unavailable in every
   one).

Run `node scripts/production-readiness-check.js` — it will not report
all-clear until all of the above are real, and that is correct
behavior, not a bug to work around.

## 3. Rollback

**Status: READY FOR IMPLEMENTATION.**

1. **Application rollback (no schema change involved)** — redeploy the
   previous image tag for the affected process (API/worker/web
   independently, per `docs/deployment-architecture.md`). Since
   migrations are applied as a separate step (never baked into
   container startup), a pure application rollback never needs a
   database action.
2. **Rollback involving a migration** — Prisma migrations are
   forward-only; there is no generated "down" migration. Two options,
   neither automated here (a genuinely destructive/hard-to-automate
   decision, left to a human):
   - Write and apply a new, forward migration that reverses the
     problematic schema change (preferred — keeps migration history
     linear and matches what `prisma migrate deploy` expects).
   - Restore from a pre-migration backup (§4/§5 below) if the migration
     already caused data loss/corruption a forward migration can't fix
     — this is the disaster-recovery path, not a routine rollback.
3. After any rollback, run `npm run check:integrity -w apps/api`
   (`financial-integrity-checks.js`) before resuming normal traffic.

## 4. Database backup

**Status: VERIFIED** for the mechanism itself — see
`docs/database-backup-recovery.md` §6 for the actual backup/restore
drill that ran and passed. Full procedure: same document, §3.
Summary: `infra/backup.sh` (`pg_dump -Fc`, run against the
docker-compose Postgres or any deployment exposing the same container
name/credentials pattern), retained locally per `RETENTION_DAYS`. **No
off-site copy or encryption is configured** — see that document's §3
for why, and treat this as a hard blocker before production (§2 above).

## 5. Database restore

**Status: VERIFIED** for the mechanism (§4 above); **READY FOR
IMPLEMENTATION** for the full incident procedure. Full steps:
`docs/database-backup-recovery.md` §5. Critical points worth repeating
here:

- `infra/restore.sh` always restores into a **new** database, never
  overwrites the live one — cutover is a separate, deliberate, human
  decision.
- **After any restore, run `IndependentReconciliationService`'s rescan
  (`POST /admin/reconciliation/:assetNetworkId/independent-rescan`)
  against every active asset/network before resuming trading/withdrawal
  processing** — a restore can silently lose record of on-chain activity
  that happened after the backup's snapshot point; this is the specific
  tool built to detect exactly that gap.
- Run `npm run check:integrity -w apps/api` against the restored
  database before promoting it to serve real traffic.

## 6. Blockchain worker recovery

**Status: READY FOR IMPLEMENTATION.**

1. **Worker process crashed/unhealthy** (`scripts/worker-healthcheck.js`
   reporting stale — see `docs/observability-and-alerting.md` §1) —
   restart it. `DepositWatcherService`'s per-asset-network lease
   self-expires after 5 minutes (`LEASE_STALE_AFTER_MS`) even if the
   crash happened mid-scan, so a restarted worker (or a healthy replica)
   picks the work back up on its own — no manual lease-clearing needed.
2. **Persistently stale cursor** (`GET /admin/watchers`'
   `isScanStale: true` even after a restart) — check `lastError`/
   `lastErrorAt` on the same row first (a real, recurring chain-adapter
   failure, not just "no worker is running"). If the underlying chain
   RPC endpoint is the problem, this is a **custody-provider/RPC
   outage** — see §8.
3. **Confirmed backlog after extended downtime** — the deposit
   adapters' per-address resume cursor (Phase 11,
   `per-address-cursor.util.ts`) walks backward through missed history
   bounded by `MAX_PAGES_PER_ADDRESS`; if the backlog exceeds what one
   poll can catch up on, the cursor for that address is deliberately
   left unchanged rather than skipped past — it will keep making
   progress on subsequent polls, never silently drop history. No manual
   intervention is needed for this case specifically; it's the
   designed-for degraded-but-safe behavior.
4. **Suspected missed deposits/withdrawals despite a healthy-looking
   cursor** — run the independent reconciliation rescan (§5) rather
   than trusting the watcher's own cursor, which is exactly the
   scenario that tool exists for.

## 7. Reconciliation discrepancy response

**Status: READY FOR IMPLEMENTATION.**

1. `GET /admin/reconciliation/discrepancies?status=OPEN` — review every
   open discrepancy, ordered by severity.
2. **CRITICAL** — treat as a potential real fund-safety issue. Do not
   resolve/acknowledge without independently verifying the underlying
   on-chain state (block explorer, or a second independent RPC source)
   against what VerdictVaut's records show. Escalate per §10 before
   taking any corrective action that touches balances.
3. **WARNING/INFO** — investigate during normal working hours;
   typically a transient reporting difference (e.g. confirmation-count
   timing) rather than a real gap.
4. Once understood: `POST /admin/reconciliation/discrepancies/:id/acknowledge`,
   then, after the underlying cause is actually fixed (never before),
   `POST /admin/reconciliation/discrepancies/:id/resolve` with notes
   explaining what was found and what was done. Neither endpoint
   mutates a balance/deposit/withdrawal itself — a discrepancy is
   diagnosed and closed here; any actual correction happens through the
   normal deposit-reprocessing/withdrawal-reconciliation endpoints,
   with their own audit trail.

## 8. Custody provider outage

**Status: READY FOR IMPLEMENTATION.**

1. Confirm via `provider_request_failures_total` (§`docs/observability-and-alerting.md`
   alert #4) and the provider's own status page.
2. Withdrawals already `BROADCAST`/`CONFIRMING` are unaffected — they're
   tracked by on-chain confirmation, not the custody provider's API.
3. New withdrawal **execution** (`ProductionCustodyExecutor`/
   `FireblocksCustodyAdapter.execute`) will fail per-request; nothing
   auto-retries a failed execution — an admin must investigate each
   affected withdrawal via `GET /admin/withdrawals/:id`. A failed
   execution returns the withdrawal to `APPROVED` (reservation held).
   *Correction, Phase 35:* there is no "retry execution" path —
   `approve()` only accepts `RISK_REVIEW` — so once the provider
   recovers, `POST /admin/withdrawals/:id/reject` releases the funds and
   the user submits a new request. Never edit the row back to
   `RISK_REVIEW` by hand to force a re-execution.
4. If the provider's own status is unclear from its API responses
   (timeouts, ambiguous errors) — `WithdrawalExecutionResult`'s
   "ambiguous" outcome exists for exactly this; resolve each one via
   `POST /admin/withdrawals/:id/resolve-ambiguous-execution` with the
   real, independently-verified evidence (a real txHash if one exists,
   or confirmation none does) — never guessed.
5. Sandbox-only reminder: production custody has no real provider
   integrated yet (§2) — this section applies to the sandbox Fireblocks
   integration today.

## 9. Database outage

**Status: READY FOR IMPLEMENTATION.**

1. `GET /health/ready` returns 503 — confirmed by alert #6
   (`docs/observability-and-alerting.md`). An orchestrator should
   already be pulling affected API replicas from rotation on this
   signal automatically.
2. Worker process(es): `PrismaService.onModuleInit()` connects eagerly
   at boot, so a worker that was already running keeps its existing
   connection pool and will surface errors on its next query (visible
   as `wallet.deposit_watcher.scan_failed`/`wallet.withdrawal_watcher.poll_failed` —
   alert #1); a worker restarting during the outage will fail to boot
   entirely (fail-closed, not a silent no-op).
3. If the outage is the primary database instance failing outright
   (not just transient unreachability): this is now a disaster-recovery
   event — follow §5 (restore) against the most recent backup once a
   replacement instance exists, including the mandatory independent
   reconciliation rescan before resuming traffic.
4. Do not manually "unstick" a worker by clearing a
   `BlockchainWatchCursor` lock — it self-expires after 5 minutes
   (§6.1); manual intervention here risks a genuine double-scan race if
   the original worker is actually still alive and reconnects.

## 10. Secret rotation

**Status: READY FOR IMPLEMENTATION.**

- **JWT secrets** (`JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`) —
  rotating either invalidates every outstanding token signed with the
  old value immediately (there is no dual-secret grace-period
  mechanism in `auth.module.ts` today). Plan for a forced
  re-login/re-refresh wave across all active sessions when rotating in
  production; not something to do silently mid-peak-traffic without
  warning users.
- **Database credentials** — rotate via the chosen provider's own
  mechanism (unchosen — see `docs/production-database-requirements.md`
  §5), then roll `DATABASE_URL` across every process (API, worker) as a
  coordinated redeploy — there is no live-reload of `DATABASE_URL`
  mid-process.
- **Provider secrets** (Fireblocks/Elliptic API keys) — stored only as
  `"scheme:path"` references (`credentialsSecretRef`) validated by
  `secret-ref.validator.ts`; only the `env:` scheme actually resolves
  today. Rotating means updating the referenced environment variable's
  value and restarting the process(es) that read it — the DB-stored
  `CustodyProviderConfig`/`ComplianceProviderConfig` row itself never
  contains the secret value and does not need to change unless the
  reference path itself changes.
- **After any rotation**: confirm via `GET /admin/providers/webhook-events`
  and normal request logs that calls are succeeding again — a bad
  rotation typically first shows up as a spike in
  `provider_request_failures_total` (alert #4).

## 11. Incident escalation

**Status: READY FOR IMPLEMENTATION** — a process template, not a
staffed on-call rotation (none exists to name here).

1. **Sev1 (real or suspected fund loss/exposure, database outage,
   production-affecting)** — page immediately. Do not attempt a fix
   that touches balances/withdrawals alone; a second person must
   independently verify the proposed action before it's taken,
   consistent with how every admin financial-control endpoint in this
   codebase already requires SUPER_ADMIN + produces an audit-log entry
   (`AuditLogService`) — the same "no single actor silently changes
   money" principle extends to incident response, not just the API
   surface.
2. **Sev2 (degraded but not fund-affecting** — stale watcher, elevated
   error rate, non-critical reconciliation discrepancy**)** — ticket +
   working-hours investigation, escalate to Sev1 if it turns out to
   touch balances.
3. **Every incident that touched production data** ends with a written
   postmortem referencing the specific `AuditLog`/`ReconciliationDiscrepancy`/
   `ProviderWebhookEvent` rows involved (all queryable via the existing
   admin endpoints) — this repo already makes every financial-control
   action attributable and queryable; use that, don't reconstruct events
   from memory.

---

## Phase 35 additions — operational control plane

Every procedure below is classified by who may act:

- **AUTOMATED (safe)** — the system does it; no human action needed.
- **HUMAN INVESTIGATION** — a SUPER_ADMIN acts through an audited endpoint.
- **PROVIDER INVESTIGATION** — the answer lives with the custody/RPC provider.
- **PROHIBITED** — could duplicate or lose funds; never do it.

## 12. Scheduled reconciliation

**Status: READY FOR IMPLEMENTATION** (lease/concurrency behavior VERIFIED
against real Postgres — `test/integration/phase35-operations.integration-spec.ts`).

- Enable in the **worker** process only: `RECONCILIATION_SCHEDULER_ENABLED=true`
  (the API process refuses to boot with it set — `watcher-boundary.guard.ts`).
- Runs, per active asset/network, the independent rescan (§5/§7) plus the
  market collateral check-all. **Both are read-only with respect to money**
  — they only create `ReconciliationRun`/`ReconciliationDiscrepancy` rows
  and audit entries. Nothing here can credit, settle, release, or post.
- Cadence: `RECONCILIATION_SCHEDULER_INTERVAL_MS` (default 1h),
  `RECONCILIATION_SCHEDULER_TICK_INTERVAL_MS` (default 60s),
  `RECONCILIATION_SCHEDULER_LEASE_STALE_AFTER_MS` (default 30m). These are
  **operational parameters with conservative defaults, not a decided
  production reconciliation policy** — each rescan makes real RPC calls,
  so the right interval depends on the RPC plan and chain count chosen at
  go-live.
- Multi-replica safe: each job is leased in `scheduled_job_states`; across
  any number of workers a job runs at most once per interval. A killed
  worker's lease is reclaimed after the stale window — **AUTOMATED**.
- Monitoring: `GET /admin/jobs` (`lastStartedAt`/`lastSuccessAt`/
  `lastError` per job); metrics `operations.reconciliation_job.{started,completed,failed}`.
  A job whose `lastSuccessAt` is older than ~2x the interval while the
  scheduler is enabled means reconciliation is falling behind.
- Deleting `scheduled_job_states` rows is harmless but pointless (it only
  makes every job due at once). **PROHIBITED:** deleting
  `reconciliation_discrepancies` rows — resolve them (§7).

## 13. Stuck withdrawal

**Status: READY FOR IMPLEMENTATION.** Find candidates with
`GET /admin/withdrawals/stale?olderThanMs=<ms>` (default 1h) and the
`withdrawal_chain_mismatch` / `withdrawal_tx_missing` discrepancies.

| State | Normal exit | If stuck — who acts, with what evidence |
|---|---|---|
| `RISK_REVIEW` | SUPER_ADMIN approve/reject; user cancel | HUMAN: review and decide. |
| `APPROVED` | reject (after a failed execution) | HUMAN: `reject` releases funds; user resubmits (§8). |
| `BROADCASTING` | executor settles within one request | Only after a worker/process death mid-execute. HUMAN: `POST /admin/withdrawals/:id/declare-execution-ambiguous`, then §14. |
| `PENDING_MANUAL_BROADCAST`, manual executor (no `custodyReference`) | admin records txHash | HUMAN: record the real txHash (`/broadcast`), or if it was never sent, `declare-execution-ambiguous` then §14. |
| `PENDING_MANUAL_BROADCAST`, provider-held (`custodyReference` set) | watcher/webhook applies the provider outcome | PROVIDER INVESTIGATION. `declare-execution-ambiguous` is **refused** — the provider may still broadcast. Cancel/resolve at the provider; its outcome arrives automatically. |
| `EXECUTION_AMBIGUOUS` | `resolve-ambiguous-execution` | HUMAN + PROVIDER: §14. |
| `BROADCAST`/`CONFIRMING`, chain says **not_found** | watcher confirms | Mistyped hash, dropped or replaced tx. HUMAN: `declare-execution-ambiguous` (the server re-checks the chain live and refuses unless still not_found; the stale hash is cleared but kept in the audit row), then §14. |
| `BROADCAST`/`CONFIRMING`, chain shows the tx but **destination/amount mismatch** | — | **Needs a product decision (R1, open).** Funds genuinely moved on-chain to the wrong place/amount; who bears the loss is a business/legal question. The withdrawal stays `CONFIRMING` with the reservation held — safe and conservative. Escalate Sev1 (§11). The endpoint above **refuses** this case by design. |
| `BROADCAST`/`CONFIRMING`, chain says **failed** | watcher fails it (AUTOMATED) | Nothing to do; if the watcher is down, see §15. |

**PROHIBITED** in every row: editing withdrawal status/txHash in SQL;
releasing a reservation directly; "retrying" by resetting a row to
`RISK_REVIEW`.

## 14. Ambiguous custody execution

**Status: READY FOR IMPLEMENTATION.**

1. Establish what actually happened — **never infer it from the request**:
   the provider dashboard / `checkStatus()` for a custody provider; the
   operator's own wallet history for a manual broadcast; for EVM, whether
   the sending nonce was consumed and by which tx; for BTC, whether the
   inputs were spent and by which tx.
2. A real transaction exists: `POST /admin/withdrawals/:id/resolve-ambiguous-execution`
   with `{outcome: "CONFIRMED_BROADCAST", txHash}`. The withdrawal returns
   to `BROADCAST`; the watcher credits it **only** if the chain shows that
   hash paying the recorded destination/amount.
3. Provably nothing was or can still be executed: `{outcome: "CONFIRMED_NOT_EXECUTED"}`,
   then `reject` to release funds. For a dropped transaction, "provably"
   means the signed transaction can no longer be mined (nonce/inputs
   consumed elsewhere) — a merely-dropped signed tx can be rebroadcast by
   anyone holding it. Two-person verification (§11) before releasing.
4. **PROHIBITED:** resolving `CONFIRMED_NOT_EXECUTED` while a provider
   request is still pending or a signed transaction is still mineable.

## 15. Watcher outage / duplicate or replayed events

**Status: READY FOR IMPLEMENTATION.**

- Deposit watcher: `GET /admin/watchers` (`isScanStale`, `lastError`) — §6.
- Withdrawal watcher: `GET /admin/jobs`, row `withdrawal-watcher`
  (`lastStartedAt`/`lastSuccessAt`/`lastError`, written by the worker on
  every pass). The API's own `GET /admin/watchers/withdrawals` and
  `/health/ready` describe only the **API process**, which never runs this
  watcher — do not read them as the worker's health.
- During an outage nothing is credited or failed; withdrawals simply wait.
  On recovery the watcher re-lists and catches up — **AUTOMATED**.
- Duplicate/replayed provider webhooks and repeated polls are
  **AUTOMATED**-safe: webhook events are de-duplicated by event identity,
  and every watcher/webhook transition is a status-scoped CAS (a replay
  matches zero rows). `POST /admin/providers/webhook-events/:id/reprocess`
  re-applies only the stored payload.

## 16. Reservation / ledger anomaly

**Status: READY FOR IMPLEMENTATION.**

- Detect: `npm run check:integrity -w apps/api` (reservedBalance vs ACTIVE
  reservations, orphan reservations/ledger references — Phase 32), plus
  the DB-level zero-sum posting trigger, which rejects an unbalanced
  transaction outright.
- Any failure is **Sev1** (§11). **HUMAN INVESTIGATION** only: identify
  the referenced Order/Withdrawal and its audit trail before anything else.
- **PROHIBITED:** hand-editing `ledger_accounts` balances,
  `fund_reservations`, or posting ad-hoc `ledger_transactions`. There is
  deliberately no admin "adjust balance" endpoint; a correction requires
  an explicit, reviewed code/migration change with its own audit trail.

## 17. Admin emergency handling

**Status: READY FOR IMPLEMENTATION.**

- Stop new exposure without touching funds: pause/close markets
  (`POST /markets/:id/pause|close`); deactivate an asset/network
  (`PATCH /admin/asset-networks/:id/active` — blocks new withdrawals on
  it); disable a custody provider config
  (`POST /admin/custody/providers/:id/disable` — execution then fails
  closed).
- Suspected compromised admin account: revoke its sessions and demote or
  suspend it directly in the database (there is no role-management
  endpoint). Every admin route re-reads role and ACTIVE status from the DB
  on each request, so this takes effect immediately, not at token expiry.
- Every one of these actions is audit-logged; none moves money.
