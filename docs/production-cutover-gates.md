# Production Cutover Gates — Phase 40

Status as of commit `d49ca5d` + Phase 40 working-tree changes. Gates are
sequential: a gate is not attempted until everything before it is PASS.
**No AWS resource was provisioned and no provider was contacted in Phase 40**
— the execution environment has no AWS CLI, no AWS credentials, no
Terraform, no Docker and no GitHub CLI, so the account identity required
before any provisioning could not be verified (40D). Everything from 40C on
is therefore BLOCKED, not NOT RUN by choice.

## Gate status

| Gate | Status | Evidence / reason | To unblock |
|---|---|---|---|
| 40A Repository | PASS | `main` at `d49ca5d`, Phase 39 committed, 1 commit ahead of origin | — |
| 40B Configuration audit | PASS (code) | Every env var classified (below); production + unsafe values refuse to boot; 2 code blockers found and fixed | — |
| 40C AWS provisioning | BLOCKED | No AWS CLI/credentials/Terraform available | Operator machine or CI runner with Terraform ≥ the version pinned in `infra/terraform`, AWS CLI v2, and credentials for a named deployment role |
| 40D Account/region/cost governance | BLOCKED | `aws sts get-caller-identity` cannot run | Confirm the intended account id + region (docs/aws-region-selection.md), create the state backend (docs/aws-account-governance.md), budget alarms, GitHub OIDC trust |
| 40E Database | BLOCKED | Needs 40C; instance class deliberately undecided | Choose class from Phase 38 inputs (docs/performance-and-capacity.md §5) |
| 40F Backup/PITR | BLOCKED | Needs RDS; local drill PASS (31/31) only | Enable automated backups/PITR, then run a restore into a non-production instance and `financial-integrity-checks.js` against it |
| 40G Images | BLOCKED | No Docker locally (CI `docker-build` job builds them) | Build/scan/push via `ecr-publish.yml` (workflow_dispatch) once ECR exists |
| 40H Staging deploy | BLOCKED | Needs 40C–40G | Deploy, then `npm run rc:simulate` pointed at a **disposable** staging DB and the Phase 38 staging load parameters |
| 40I Provider sandboxes | BLOCKED | No sandbox credentials in this environment | Fireblocks/Elliptic sandbox accounts → `docs/fireblocks-sandbox-smoke-test.md` |
| 40J Production custody | BLOCKED / NOT IMPLEMENTED | `ProductionCustodyExecutor` intentionally throws; boot refuses production | Provider contract + a real adapter behind `WithdrawalExecutor`; production withdrawals stay blocked until verified |
| 40K Compliance | BLOCKED / NOT IMPLEMENTED | Production forces `DeferredComplianceGate`; boot refuses production | KYC + sanctions/KYT provider contracts and a real `WithdrawalComplianceGate` |
| 40L Production RPC | BLOCKED | No endpoints/credentials | Per-network authenticated endpoints; mainnet codes have **no** default URL (fail closed) |
| 40M Email | BLOCKED | No verified domain/token | Postmark server token + verified sender domain; staging send first |
| 40N Alerting | BLOCKED | Alarms exist only in Terraform; no sink verified | Provision SNS subscription, trigger a test alarm, confirm receipt |
| 40O DNS/TLS/edge | BLOCKED | No domain/zone | Domain decision, Route 53 zone, ACM validation |
| 40P Security | PASS (code) / BLOCKED (cloud) | Code: Phase 37 suite, secret scan, trust-proxy, DTO guard; cloud IAM/SG review needs 40C | IAM + security-group review against the applied plan |
| 40Q Production migration | BLOCKED | Needs RDS; migration safety PASS locally | Backup → safety scan → `migrate deploy` via the controlled ECS task |
| 40R Production smoke | BLOCKED | Needs deployment | `scripts/production-smoke-test.js` (read-only) |
| 40S Trading gate | BLOCKED | Custody, compliance, RPC, alerting, PITR not PASS | All 13 required controls PASS |
| 40T Gradual enablement | Documented | No feature-flag system exists for staged rollout | Stages are enforced by configuration instead: asset/networks inactive until enabled, markets DRAFT until opened, withdrawals blocked while custody/compliance are placeholders |
| 40U Post-deploy reconciliation | BLOCKED | Needs deployment | Scheduler + integrity script |
| 40V Rollback | Documented (staging rehearsal BLOCKED) | docs/rollback-runbook.md, operations-runbook §3/§13–17 | Rehearse in staging |

## 40B — configuration classification

| Variable | Class | Production requirement / behaviour |
|---|---|---|
| `DATABASE_URL` | REQUIRED, SECRET | TLS enforced in production (`database-tls.validator.ts`); from Secrets Manager |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | REQUIRED, SECRET | ≥ 32 chars; **must differ** (boot refuses otherwise) |
| `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | OPTIONAL, PUBLIC | defaults 15m / 7d |
| `APP_ENVIRONMENT` | REQUIRED, PUBLIC | `production` refuses to boot until custody/compliance exist |
| `NODE_ENV` | PUBLIC | `production` in every image (hides dev verification token) |
| `PORT` | PUBLIC | 4000 in Terraform |
| `TRUST_PROXY_HOPS` | REQUIRED behind ALB, PUBLIC | `1` in both Terraform envs |
| `CORS_ALLOWED_ORIGINS` | REQUIRED, PUBLIC | explicit allowlist (empty = none) |
| `EMAIL_PROVIDER`, `EMAIL_FROM_ADDRESS`, `EMAIL_BASE_URL` | PRODUCTION REQUIRED, PUBLIC | production refuses `none` |
| `POSTMARK_SERVER_TOKEN` | PRODUCTION REQUIRED, SECRET, EXTERNAL | from Secrets Manager |
| `<NETWORK_CODE>_RPC_URL` | EXTERNAL DEPENDENCY, SECRET (may embed API keys) | mainnet codes have no default → unset = fail closed |
| Custody/compliance credentials | EXTERNAL, SECRET | stored as secret **references** in provider-config rows, resolved at call time |
| `CHAIN_WATCHER_*`, `WITHDRAWAL_WATCHER_*`, `RECONCILIATION_SCHEDULER_*`, `WORKER_HEARTBEAT_*` | WORKER ONLY, PUBLIC | API process refuses to run them |
| `ALLOW_WATCHERS_IN_API_PROCESS` | OPTIONAL | must stay false in split deployments |
| `ENABLE_DEV_FUNDING_TOOLS` | STAGING/DEV ONLY | inert when `NODE_ENV=production`; referenced by no code path today |

## Code blockers found and fixed in Phase 40

1. **Environment/network coupling.** Nothing tied an asset/network's
   `NetworkEnvironment` to `APP_ENVIRONMENT`: production could run with
   active testnet assets (testnet deposits credited as real balances), and
   a sandbox process could run active mainnet assets while skipping every
   production boot blocker. Now refused at boot (`ProductionSafetyGate`)
   and at activation/creation (`AssetsNetworksService`), both directions.
2. **Asset/network configuration API unusable.** `CreateAssetNetworkDto`
   had an undecorated `minConfirmations`, so the global validation pipe
   rejected every `POST /admin/asset-networks`; a fresh production database
   (the testnet-only seed is never run there) had no API path to enable a
   mainnet asset. Fixed, plus a codebase-wide test that fails if any DTO
   property ever lacks a validation decorator again.

## Phase 41 update

No gate changed status: the environment still has no AWS CLI, credentials,
Terraform, Docker or GitHub CLI, and nothing was provisioned or contacted.
Code-side items closed locally (XRP tag verification at confirmation, EVM
confirmation ceiling, idempotency-key 409, auth security metrics) and the
remaining owner decisions are listed in `docs/phase-41-decisions.md`.

IaC for **40U** (post-deploy reconciliation): the worker task definitions
now set `RECONCILIATION_SCHEDULER_ENABLED=true` (hourly), which was
previously unset, so the scheduler would have stayed off. The worker task
definitions now also receive `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`, without
which the worker failed env validation. Still open for production: the worker
has no email configuration (`docs/phase-41-decisions.md` A9).
