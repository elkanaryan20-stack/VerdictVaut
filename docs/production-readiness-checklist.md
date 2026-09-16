# Production Readiness Checklist — Phase 29

**The single authoritative production readiness assessment.** Where
`docs/aws-phase28-deployment-readiness.md` recorded what Phase 28 built
and its blockers as a historical phase report, and
`apps/api/scripts/production-readiness-check.js` /
`apps/api/scripts/production-preflight.js` are the two RUNNABLE gates,
THIS document is the current, human-readable ready/blocked/unverified
picture that composes both tools' output with the external
prerequisites neither tool can check by itself. Re-run both scripts
before trusting this document for a real go-live decision — this file
is a snapshot as of Phase 29 (2026-09-16), not a live dashboard.

**Every external prerequisite below states an owner only when this
repository itself specifies one. It never does — there is no named
individual, team, or role documented anywhere in this codebase — so
every "Owner" cell below reads "Not specified in this repository,"
consistently, rather than inventing one.**

## 1. How to reproduce this assessment

```
npm run check:production-readiness -w apps/api   # application-level gate
npm run preflight:production -w apps/api         # AWS/Terraform/CI-CD structural gate
```

Neither requires live AWS access to run (both fail closed / report
UNVERIFIED where AWS access would be needed — see each script's own
docblock). Add `--with-db` to the first once a real `DATABASE_URL` is
reachable for a deeper check.

## 2. READY

Genuinely complete, verified this phase (either re-confirmed unchanged
from a prior phase's real test run, or newly validated this phase) —
listed with the evidence, not just asserted:

| Item | Evidence |
|---|---|
| API/web/worker code — unit + integration + typecheck/lint/build | 82/82 API unit suites (780 tests), 27/27 integration suites (253 tests), 42/42 web suites (222 tests), typecheck/lint/build all clean — re-run this phase, see §6 below for exact output |
| Terraform syntax/structure | `terraform fmt -check` + `terraform validate` clean for `staging`/`production`/`shared` — re-run this phase (Phase 28's own first real run); GitHub Actions workflow YAML re-validated this phase with `js-yaml` |
| Container/CI configuration | Both Dockerfiles + `.github/workflows/ci.yml` (typecheck/lint/build/unit/integration/prisma-validation/docker-build/terraform-validate/migration-safety) — CI-validated on every push, unchanged this phase except the new migration-safety job |
| Application health checks | `GET /health` (liveness), `GET /health/ready` (DB connectivity) — both re-verified live against a real running server this phase (see §6) |
| Deployment/rollback documentation | `docs/aws-deployment-runbook.md`, `docs/production-deployment-plan.md` §7, **new this phase**: `docs/rollback-runbook.md` |
| Observability configuration (code) | `infra/terraform/modules/observability` (Phase 28) — CloudWatch alarms/SNS/RDS-event-subscription/EventBridge, DESIGNED and validated, not provisioned |
| ECS deployment safety | `deployment_circuit_breaker` (Phase 28) + `verify-deployment` post-deploy smoke-test job (**new this phase**) |
| Security controls (application-level) | `docs/security-and-operational-validation.md` (Phase 17) — auth/authorization/financial-invariant/failure-injection/watcher/custody-boundary/compliance-boundary/API-security audit, re-confirmed unchanged this phase by re-running the same test suites |
| Fail-closed production safety gates | `ProductionCustodyExecutor` (unconditional throw), `ComplianceGateFactory` (forces `DeferredComplianceGate` in production) — re-verified this phase by re-reading both files; unchanged |
| Migration deployment process | `prisma migrate deploy` as a separate, single-instance step (never in container startup); `guard-destructive-migration.js` (blocks dev-migration commands against production env vars); **new this phase**: `check-migration-safety.js` (blocks unacknowledged destructive SQL in newly added migrations, wired into CI) |
| Operational smoke-test tooling | **New this phase**: `production-smoke-test.js` — built, and actually run against a real live local server this phase (see §6), never against a real deployment (none exists) |

## 3. BLOCKED

A real, confirmed negative fact — not a guess, not "probably missing."
Every row states the exact check that confirmed it.

| Item | Owner | Required configuration | Verification method | Status | Blocker reason |
|---|---|---|---|---|---|
| AWS account | Not specified in this repository | An authorized AWS account | `production-preflight.js` (`aws sts get-caller-identity`) | BLOCKED | No AWS account exists — `docs/aws-account-governance.md`, REQUIRES HUMAN APPROVAL |
| Terraform state backend | Not specified in this repository | S3 bucket (versioned, encrypted, public-access-blocked) + DynamoDB lock table, one per account | `production-preflight.js` (checks `backend.tf` for the `EXAMPLE ONLY` placeholder) | BLOCKED | All 3 `backend.tf` files still reference the placeholder — confirmed this phase |
| Real `terraform.tfvars` per environment | Not specified in this repository | `staging`/`production`/`shared` — real region/AZ/CIDR/image/domain values | `production-preflight.js` (file presence only, never reads contents) | BLOCKED | None exist — only the committed `.tfvars.example` files |
| Production AWS IAM/OIDC | Not specified in this repository | `AWS_TERRAFORM_ROLE_ARN`/`AWS_CI_DEPLOY_ROLE_ARN` GitHub Actions secrets, real OIDC provider + role applied from `modules/ci-deploy-role` | `production-preflight.js` (local-shell presence only — cannot check the real GitHub secret) | BLOCKED / UNVERIFIED | Terraform module exists (Phase 28); nothing provisioned; secrets not set |
| DNS/ACM | Not specified in this repository | A registered domain, Route 53 hosted zone, DNS-validated ACM certificate | `production-preflight.js` (checks for `certificate_arn` in a real tfvars) | BLOCKED | No domain/region decision has been made — `docs/aws-region-selection.md`, `docs/aws-production-architecture.md` §10 |
| Production secrets (Secrets Manager) | Not specified in this repository | `verdictvaut/production/*` secret VALUES (JWT, DATABASE_URL is auto-generated, Postmark token) | `production-readiness-check.js` (local env-var checks); real Secrets Manager objects require AWS access, UNVERIFIED | BLOCKED (objects don't exist) / UNVERIFIED (values, once objects exist) | No AWS account; no secret values ever set anywhere in this repository (grepped, zero matches) |
| Production email provider | Not specified in this repository | A real (non-sandbox) Postmark server token + a verified sending domain (SPF/DKIM) | `production-readiness-check.js`'s email check | BLOCKED | `EMAIL_PROVIDER=postmark` requires `POSTMARK_SERVER_TOKEN`/`EMAIL_FROM_ADDRESS`/`EMAIL_BASE_URL`, none set; even if set, `env.validation.ts` independently refuses to boot production without them |
| Production custody/signing provider | Not specified in this repository | A real, tested provider (Fireblocks production tier, or another) | `production-readiness-check.js`'s structural check (reads `production-custody.executor.ts`'s source) | BLOCKED, by design | `ProductionCustodyExecutor.execute()` unconditionally throws — verified unchanged this phase |
| Production KYC/AML/sanctions provider | Not specified in this repository | A real, tested compliance provider (or a documented manual process) | `production-readiness-check.js`'s structural check (reads `compliance-gate.factory.ts`'s source) | BLOCKED, by design | `ComplianceGateFactory` forces `DeferredComplianceGate` in production regardless of configuration — verified unchanged this phase |
| Managed database backup/HA | Not specified in this repository | A managed provider or self-hosted HA/WAL-archiving decision, automated backups, PITR, off-site storage | `production-readiness-check.js` (`NOT CONFIGURED` status) + `docs/production-database-readiness.md` §12 | BLOCKED | No managed provider chosen; local `pg_dump` tooling is real and passing but is not a substitute — unchanged since Phase 22 |
| GitHub Environment protection rules | Not specified in this repository | `staging-infra-apply`/`staging-deploy`/`production-infra-apply`/`production-deploy` Environments with required reviewers (production pair at minimum) | Cannot be checked by any script — requires a repository admin in GitHub Settings | UNVERIFIED (see §4) | Workflow files (Phase 28/29) reference these names but cannot create the protection rule |

## 4. UNVERIFIED

Genuinely cannot be checked without access this phase does not have —
listed explicitly rather than silently omitted or assumed PASS:

| Item | Why it cannot be verified locally | How a human verifies it |
|---|---|---|
| GitHub Environment protection rules exist and require reviewers | No script has GitHub API access with sufficient permission | Repository admin: Settings > Environments, inspect each of the 4 named above |
| `AWS_TERRAFORM_ROLE_ARN`/`AWS_CI_DEPLOY_ROLE_ARN` GitHub secrets are actually set | GitHub secrets are never readable by any script, including CI itself | Repository admin: Settings > Secrets and variables > Actions |
| A real AWS account/credentials work end-to-end | No AWS account exists to test against | Run `production-preflight.js` from a shell with real AWS credentials configured, or run `terraform-deploy.yml`'s `terraform-plan` job for real once secrets are set |
| The real Fireblocks/Elliptic sandbox APIs behave as VerdictVaut's own mocks assume | No live sandbox credentials exist in any session to date | `docs/fireblocks-sandbox-smoke-test.md`'s prerequisite checklist, never executed |
| CloudWatch alarms actually fire and reach a real subscriber | No AWS account/SNS subscription exists | Once provisioned: trigger a real test event per alarm, confirm the SNS topic delivers, confirm the subscriber receives it |
| Docker images actually boot correctly on a real Docker daemon outside CI | Docker unavailable in every local session to date; CI's `docker-build` job is the only place this is exercised | A human with Docker available should run the same smoke test CI already runs, locally, at least once |
| Failover/regional-disaster recovery procedures actually work | No managed HA provider chosen; no cross-region deployment exists | `docs/disaster-recovery-runbooks.md` runbooks G/I — explicitly marked NOT APPLICABLE TODAY, not silently assumed to work |
| Real production traffic/load behavior | No load test has ever been run against this schema/application at any replica count | A real load test, once a staging environment exists — out of this phase's scope, not attempted |

## 5. Real-money safety — explicit statement

Per this phase's own instruction, stated plainly, not just implied by
the tables above: **production CANNOT be considered ready while any of
the following remain true**, and none of the mitigations below is a
substitute for closing the actual gap:

- Production custody is absent (`ProductionCustodyExecutor` throws).
- Production compliance is absent (`ComplianceGateFactory` forces
  `DeferredComplianceGate`).
- Required transaction monitoring (the compliance provider's
  address-risk/sanctions screening) is absent — the same gap as above,
  restated because it is a distinct real-money-safety property, not
  merely a duplicate line item.
- Production operational approvals (GitHub Environment protection,
  a human-reviewed Terraform plan, a real go-live decision) are absent.

**Sandbox/manual custody remains the only safe testing boundary.**
`ManualBroadcastExecutor` (sandbox) and `DeferredComplianceGate`
(always-defer-to-a-human) are the two mechanisms that make it safe to
exercise the rest of this system today — they are not weakened,
bypassed, or worked around anywhere in this phase's changes, verified
by re-reading both this phase and confirming zero diff to either file.

## 6. Testing performed this phase (exact results)

See the final phase report for the complete, literal command output —
not duplicated here to avoid two sources of truth for the same
numbers. Summary: all pre-existing suites green (no regression), the 3
new Phase 29 scripts (`production-preflight.js`,
`check-migration-safety.js`, `production-smoke-test.js`) built AND
actually exercised against a real, live local server (embedded
Postgres + a real `node dist/main.js` process — not simulated), all
new-file YAML validated with `js-yaml`, `production-readiness-check.js`
unchanged in outcome (no new P0/P1 introduced or removed — this phase
added no application-level safety-relevant check, only deployment/
observability tooling).

## 7. What this document does not do

- Does not claim production readiness — the BLOCKED/UNVERIFIED tables
  above are the actual, current state.
- Does not invent an owner, AWS account ID, credential, domain, or
  provider capability anywhere.
- Does not weaken, bypass, or add a workaround for any existing
  production safety gate.
- Does not replace `production-readiness-check.js`/`production-preflight.js`
  as the runnable source of truth — re-run both before any real go-live
  decision; this document can go stale, the scripts cannot lie about
  what they actually checked at the moment they ran.
