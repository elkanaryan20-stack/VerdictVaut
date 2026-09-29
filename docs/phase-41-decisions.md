# Phase 41 — Decisions, Backlog and Local Verification

Baseline: `main` at `4e95530` (Phase 40). Nothing here provisions cloud
resources, contacts a provider, or activates a fee schedule. Every item is
classified as:

- **A — technical**: a correctness or safety call with one defensible answer. Implemented in Phase 41.
- **B — business**: needs an owner's policy decision. **Not implemented**; the current behaviour and the options are recorded.
- **C — infrastructure**: waits on AWS or providers (see `docs/production-cutover-gates.md`).

## A — technical decisions implemented in Phase 41

| # | Decision | Where | Tests |
|---|---|---|---|
| A1 | **XRPL destination tag is verified at withdrawal confirmation (R2).** On a shared exchange address the tag selects the beneficiary, so the right address with a wrong or missing tag pays someone else. The XRP provider now reports the transaction's `DestinationTag` (`null` = none; `undefined` = chain has no tags). `findChainMismatch` refuses to credit on any difference. This is the one rule shared by automatic confirmation, manual reconcile and scheduled reconciliation. | `custody-provider.interface.ts`, `xrp-custody.provider.ts`, `withdrawal-chain-match.util.ts`, `withdrawal-watcher.service.ts` | `withdrawal-chain-match.util.spec.ts` (6), `xrp-custody.provider.spec.ts`, `withdrawals.service.spec.ts` (3) |
| A2 | **EVM deposit cursor never passes a block younger than the confirmation requirement.** EVM scans each block exactly once. With `minConfirmations` > 13 the cursor used to advance past blocks at 13 confirmations, so their deposits were recorded PENDING with no later automatic re-check (only admin reprocess). The ceiling is now `tip − max(12, required − 1)`. | `deposit-chain-adapter.interface.ts`, `evm-deposit-adapter.ts`, `deposit-watcher.service.ts` | `evm-deposit-adapter.spec.ts` (2) |
| A3 | **Idempotency-key reuse with different parameters → HTTP 409.** An identical replay still returns the original order or withdrawal. A different order (market / outcome / side / price / quantity) or withdrawal (asset-network / address / tag / amount) under the same key used to silently return the *other* record. The client then believed a request it never made had succeeded. The web client already mints a fresh key on edit, so it never hits this path. | `orders.service.ts`, `withdrawals.service.ts` | `orders.service.spec.ts` (3), `withdrawals.service.spec.ts` (3) |
| A4 | **Concurrent refresh collision stays a plain 401 (no mass revocation).** Two tabs refreshing at once look identical to a race. Only a *later* replay of a rotated-out token revokes every session. Both are now counted separately (`auth.refresh_token_concurrent_rotation_rejected`, `auth.refresh_token_reuse_detected`), so the choice can be revisited with data. | `auth.service.ts` | `auth.service.spec.ts` (5 metric tests) |
| A5 | **Security metrics.** `auth.login_failed` (per attempt, `reason` tag, never an email or id), plus the two refresh metrics above. | `auth.service.ts`, `docs/observability-and-alerting.md` #12–14 | as A4 |
| A6 | **Permission and environment matrices pinned by tests.** Every market lifecycle route has an exact role test: ADMIN for create/open/close/pause/resume; SUPER_ADMIN only for cancel/resolve/retry-settlement/category creation. Every `APP_ENVIRONMENT` × `NetworkEnvironment` pairing has a test, including a typo'd value failing closed. | — | `markets.controller.authorization.spec.ts`, `assets-networks.service.spec.ts` (8) |
| A7 | **Manual release-candidate CI workflow.** `workflow_dispatch` only. Runs the RC simulation, backup drill, perf suite and readiness report. No AWS, no secrets, deploys nothing. | `.github/workflows/release-candidate.yml` | not executed here (no GitHub runner available locally) |

### A8 — Reconciliation cadence in Terraform (applied at the owner's request)

Neither worker task definition
(`infra/terraform/environments/{staging,production}/main.tf`) set
`RECONCILIATION_SCHEDULER_ENABLED`. The code default is `false`, so the
scheduled independent + collateral reconciliation built in Phase 35 would
**never have run** once deployed. Now set on the **worker** only, in both
environments:

```hcl
RECONCILIATION_SCHEDULER_ENABLED     = "true"
RECONCILIATION_SCHEDULER_INTERVAL_MS = "3600000" # hourly — the code default
```

It is read-only reconciliation: it records discrepancies and never moves
funds. The API task definitions are unchanged, and `watcher-boundary.guard.ts`
refuses the scheduler in the API process anyway.

Verified with the compiled code: the worker env map validates and resolves
to `{enabled: true, intervalMs: 3600000}`. **`terraform fmt`/`validate` were
NOT run**: Terraform is not installed here. The `ci.yml` terraform job runs
both on the next push.

### A9 — Worker JWT secret wiring (fixed at the owner's request)

**Worker task definitions lacked the JWT secrets.** The worker boots
`AppModule` (`worker.main.ts`), so it runs the same `validateEnv`, which
requires `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` (≥ 32 chars each).
Both worker `secret_arns` blocks supply only `DATABASE_URL` (plus the
Fireblocks sandbox credentials in staging). As written, **the worker would
fail environment validation at boot in both environments**, independent of
the scheduler change. Reproduced against the compiled code with the exact
Terraform variables.

It was never caught because the RC simulation and the staging validation
start the worker with the JWT variables set.

**Fix:** both worker `secret_arns` now map `JWT_ACCESS_SECRET` and
`JWT_REFRESH_SECRET` to the same existing secrets the API uses. No new
secret was created and no application code changed. **No IAM change was
needed**: secrets are injected by the ECS execution role, which every
service shares, and that role's `secretsmanager:GetSecretValue` already
covers every `module.secrets` ARN, including both JWT secrets. The staging
worker's effective environment now passes `validateEnv`.

**Remaining (production only, not fixed):** the production worker also lacks
`EMAIL_PROVIDER`, `EMAIL_FROM_ADDRESS`, `EMAIL_BASE_URL` and
`POSTMARK_SERVER_TOKEN`, which `assertProductionEmailConfigured` requires
whenever `APP_ENVIRONMENT=production`. It is masked today by the intentional
"production not supported yet" block, but it must be wired, or the check
scoped, before production can boot the worker.

## B — business decisions (owner required; current behaviour unchanged)

| # | Decision | Current behaviour | Options |
|---|---|---|---|
| B1 | **R1 loss allocation.** Who absorbs a confirmed on-chain mismatch (wrong amount or destination)? | Crediting is refused, the withdrawal stays CONFIRMING with its reservation held, and a CRITICAL discrepancy and audit row are raised (runbook §13). No automatic resolution. | Platform absorbs / recover from the counterparty / per-case review board. Needs a finance and legal owner. |
| B2 | **Trading and withdrawal fee schedule.** | `ZeroFeeCalculator` and `ZeroWithdrawalFeeCalculator` are bound. The ledger paths for non-zero fees exist and are tested (FEE posting to `HOUSE:FEE_REVENUE`). **No schedule was activated.** | Maker/taker bps, flat per-network withdrawal fee, etc. Once non-zero, every fill writes the single `FEE_REVENUE` house row: a serialization hot spot across all markets. Before activating, shard it (per-market or per-bucket house accounts summed in reporting) or accept the measured retry rate (`db.transaction.retry`). |
| B3 | **Daily withdrawal limit semantics.** | `RiskLimit.maxDailyWithdrawal` is one number applied separately to each asset in *that asset's own units* over a trailing 24h (e.g. 1000 = 1000 USDC **and** 1000 BTC). Gross `amount`, excluding REJECTED/FAILED/CANCELLED. Opt-in (null = unlimited). | Keep per-asset units / per-asset columns / a single fiat-denominated cap (needs a price source). A per-asset cap in native units is almost certainly wrong for BTC as configured. |
| B4 | **Market category lifecycle.** | Create (SUPER_ADMIN, audited) and list exist. No rename, retire or delete. | Whether categories can be retired, and what happens to markets in them. |
| B5 | **User administration.** | No role-change or suspend/unsuspend admin API (the SUSPENDED status is enforced at login and refresh, but is set only via the database). | Which roles may suspend whom; the two-person rule for role grants. |
| B6 | **Pagination and history retention.** | Per-user withdrawal and position lists are unbounded; other lists use offset pagination. Fine at current scale (`docs/performance-and-capacity.md`). | Cursor pagination plus retention windows once volume justifies it. |

## C — infrastructure (waits on AWS / providers)

Unchanged from `docs/production-cutover-gates.md` 40C–40V. Also:

- the RDS instance class (sized from `docs/performance-and-capacity.md` §5);
- a cross-replica hot market (the per-market `KeyedSerialQueue` serializes within one API replica only; across replicas SERIALIZABLE and CAS stay correct, but retries rise);
- CloudWatch alarms for the new metrics (#12–14): **not provisioned, not claimed operational**.

## Chain coverage — LOCAL FIXTURE VERIFIED vs PRODUCTION NETWORK VERIFIED

"LOCAL FIXTURE VERIFIED" means unit or integration tests over recorded or
constructed RPC payloads, or the RC simulation's local fake EVM node. **No
chain is PRODUCTION NETWORK VERIFIED**: no mainnet (or public testnet) RPC
was contacted in Phase 41.

| Chain | Deposit scan / mapping | Withdrawal status + destination check | Status |
|---|---|---|---|
| EVM (ETH / ERC-20) | `evm-deposit-adapter.spec`, `evm-tx.mapper.spec`, RC simulation (fake node) | `evm-custody.provider.spec` (revert → failed, `to` check) | LOCAL FIXTURE VERIFIED |
| Bitcoin | `bitcoin-deposit-adapter.spec`, `bitcoin-tx.mapper.spec` | `bitcoin-custody.provider.spec` (per-output sum, change output, bech32 case) | LOCAL FIXTURE VERIFIED |
| Solana | `solana-deposit-adapter.spec`, `solana-tx.mapper.spec` | `solana-custody.provider.spec` (err → failed; no single destination, a documented limitation) | LOCAL FIXTURE VERIFIED |
| XRPL | `xrp-deposit-adapter.spec`, `xrp-tx.mapper.spec`, reconciliation integration specs | `xrp-custody.provider.spec` (tec* → failed, **destination tag — Phase 41**) | LOCAL FIXTURE VERIFIED |
| Any mainnet | — | — | NOT RUN — no endpoints or credentials (gate 40L) |
