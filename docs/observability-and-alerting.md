# Observability & Alerting — Phase 16

What exists today for seeing into a running VerdictVaut deployment, and
the concrete alert conditions this document defines against it. This is
provider-neutral by design — see `MetricsService`'s own docblock: no
Prometheus/Datadog/CloudWatch/etc. vendor is chosen or connected
anywhere in this codebase. Wiring a real backend means implementing
`MetricsService`'s three methods (`increment`/`gauge`/`timing`) and
swapping the binding in `observability.module.ts`; every alert
condition below is defined in terms of the metric/log names that
already exist, so it survives that swap unchanged.

**Status: READY FOR IMPLEMENTATION for every alert condition below** —
none has ever fired against a real alerting backend, because none is
connected. What IS verified: every named metric/log line/endpoint field
below genuinely exists in the current code (grep the file/line cited)
and is exercised by that file's own unit tests.

## 1. What exists

### Structured logs
`JsonLoggerService` (`src/observability/json-logger.service.ts`) — one
JSON object per stdout line: `timestamp`, `level`, `context` (component
name), `message`, `requestId` (when a request is in flight — see
`request-context.ts`), and `meta`. `redactSensitiveFields`
(`redact.util.ts`) redacts any object key matching
`password|secret|token|jwt|privatekey|mnemonic|seed|authorization|cookie|api_?key`
(case-insensitive) before it's ever serialized — applies to every log
call site with zero changes needed elsewhere. Ship stdout to whatever
log aggregator is chosen (CloudWatch Logs, Datadog, Loki, ELK, ...) —
none is invented here.

### Metrics
`MetricsService`/`LoggingMetricsService` (`src/observability/metrics.service.ts`)
— the default binding logs each metric event as a structured line
(`{"metric": ..., "type": "increment"|"gauge"|"timing", "value": ..., "tags": ...}`)
rather than shipping anywhere. Alerting on these today means a
log-based metric/alert in whatever aggregator receives this app's JSON
logs.

### Health/readiness endpoints (API process only — unauthenticated by
design, see `health.controller.ts`'s own docblock, so these report
booleans/counts only, never configuration detail)
- `GET /health` — liveness only, never touches a dependency.
- `GET /health/ready` — 503 if the database is unreachable (the one
  dependency every request needs); otherwise 200 with
  `checks.blockchainWatchers` (deposit-watcher cursor staleness) and
  `checks.withdrawalWatcher` (Phase 16 addition — in-memory poll
  staleness/`consecutiveFailures`) as informational, non-failing
  degradation signals.

### Operational visibility (SUPER_ADMIN/ADMIN-gated — may report more
detail than the public health endpoints, still never a secret value)
- `GET /admin/watchers` — deposit-watcher per-asset-network cursor/
  lease/error state.
- `GET /admin/watchers/withdrawals` (Phase 16) — in-memory withdrawal-
  watcher poll status (`enabled`, `lastPollSuccessAt`, `lastPollError`,
  `consecutiveFailures`, `isStale`).
- `GET /admin/reconciliation/discrepancies` — open/acknowledged/resolved
  `ReconciliationDiscrepancy` rows, with severity.
- `GET /admin/providers/capability-matrix` — static, code-reviewed
  provider/network support status.
- `GET /admin/providers/webhook-events` — provider webhook delivery/
  processing outcomes.
- `GET /admin/custody/providers`, `GET /admin/compliance/providers` —
  provider configuration presence/enabled state (secret VALUES are
  never returned — only `credentialsSecretRef`'s `"scheme:path"`
  reference string, per Phase 14A's design).

## 2. Alert conditions

Each entry names the concrete signal to alert on today (log-based,
against whatever aggregator receives this app's JSON stdout) and what
it means operationally.

| # | Condition | Signal | Suggested threshold |
|---|---|---|---|
| 1 | **Failed worker processing** | `wallet.deposit_watcher.scan_failed` increments (`deposit-watcher.service.ts`), or `wallet.withdrawal_watcher.poll_failed` / `confirmation_check_failed` / `provider_check_failed` increments (`withdrawal-watcher.service.ts`, Phase 16) | Any occurrence within 5 min warrants investigation; ≥3 consecutive `poll_failed` (see `GET /health/ready`'s `withdrawalWatcher.consecutiveFailures`) means the worker is likely stuck, not just hitting one transient error. |
| 2 | **Stale blockchain cursors** | `GET /health/ready`'s `checks.blockchainWatchers.staleCount > 0`, or `GET /admin/watchers`' `isScanStale`/`isLeaseStale` per asset/network | Alert on `staleCount > 0` sustained for longer than `STALE_CURSOR_THRESHOLD_MS` (see `reconciliation.service.ts`) — a single point-in-time read already accounts for normal poll cadence, so any positive reading here is real staleness, not noise. |
| 3 | **Reconciliation discrepancies** | `wallet.reconciliation.discrepancy_found` (tags: `severity`, `type` — `independent-reconciliation.service.ts`), `settlement.collateral_reconciliation.discrepancy_found` (tags: `severity`, `marketId` — `collateral-reconciliation.service.ts`) | Any `severity=CRITICAL` occurrence: page immediately (see `docs/operations-runbook.md`'s "Reconciliation discrepancy response"). `severity=WARNING`/`INFO`: ticket, not a page. |
| 4 | **Custody-provider failures** | `provider_request_failures_total` (tags: `provider`, `operation`, `errorClass` — `fireblocks-custody.adapter.ts`) | ≥5 in 10 minutes for the same `provider`+`operation`: the provider's API is likely degraded/misconfigured, not a one-off. Cross-reference `provider_ambiguous_operations_total` — any occurrence needs a human to resolve via `POST /admin/withdrawals/:id/resolve-ambiguous-execution`, never auto-retried. |
| 5 | **Repeated failed withdrawals** | `wallet.withdrawal_watcher.marked_failed` (tags: `assetNetworkId`, `reason` — Phase 16), `wallet.withdrawal.execution_ambiguous` (`withdrawals.service.ts`) | ≥3 `marked_failed` for the same `assetNetworkId` within 30 minutes: likely a systemic issue with that chain/provider, not isolated user-level failures — escalate per `docs/operations-runbook.md`'s "Custody provider outage" runbook. |
| 6 | **Database availability** | `GET /health/ready` returning 503 (`checks.database.ok === false`) | Any occurrence: page immediately — every request depends on this. An orchestrator should already be pulling the instance from rotation on this signal (that's what readiness probes are for); the alert is for the humans, not just the load balancer. |
| 7 | **Backup job failure (Phase 22)** | `infra/backups/backup-metadata.jsonl`'s newest line has `"status":"failed"`, or no new line has been appended within the expected backup cadence (see `docs/production-database-readiness.md`'s drill/monitoring cadence) | Any `"status":"failed"` line, or a missing expected run: page/ticket per severity — a silent backup failure is only discovered at restore time otherwise, which is the worst possible moment. **This signal exists as a local file `infra/backup.sh` writes, outside the application process — it is NOT wired into `MetricsService`/`JsonLoggerService` (that boundary is for the running app, not a standalone cron script) and requires an external process (cron monitoring, a log-shipping agent tailing the file, a managed provider's own backup-alerting) to actually page anyone. See `docs/production-database-readiness.md` §7 for the full honest status of this boundary.** |

## 3. Deliberately not built this phase

- **No real alerting vendor is connected** — every condition above is
  defined against log/metric lines and endpoint fields that exist
  today, ready to wire into whatever aggregator's log-based alerting
  feature is chosen, but none is chosen here.
- **No dashboard** (Grafana or otherwise) is built — same reasoning;
  the underlying data (structured logs, `GET /health/ready`, `GET
  /admin/watchers`) is real and queryable once shipped somewhere, but
  no specific visualization tool is assumed.
- **`GET /health/ready`'s response never includes provider configuration
  detail** — it's unauthenticated by design (see `health.controller.ts`'s
  docblock), and provider configuration presence/enabled state is
  already available, SUPER_ADMIN-gated, via the existing `GET
  /admin/custody/providers`/`GET /admin/compliance/providers`/`GET
  /admin/providers/capability-matrix` endpoints — duplicating it into an
  unauthenticated endpoint would only widen what an unauthenticated
  caller can learn about internal configuration for no operational
  benefit.
