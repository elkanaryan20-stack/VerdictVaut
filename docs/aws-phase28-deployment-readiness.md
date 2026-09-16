# AWS Production Provisioning Readiness — Phase 28

**Status: IMPLEMENTATION COMPLETE FOR CODE THAT CAN EXIST WITHOUT AN
AWS ACCOUNT. STILL NOT PROVISIONED — NO AWS ACCOUNT EXISTS.** This
document is the single entry point for Phase 28: what it found already
done (Phases 24-27), what it added, and — most importantly — the exact
remaining blockers, none of which this phase could close (they require
either a real AWS account/credentials this phase was never given, or a
human business decision this phase has no authority to make).

Cross-references rather than duplicates the existing `docs/aws-*.md`
set, all of which remain authoritative for what they already cover;
this document is the map, not a replacement.

## 1. What Phase 28 found already complete (not redone)

Inspected first, per this repository's standing "inspect before
building" practice — full git log/Terraform/doc read, not assumed from
memory:

- **Environment separation** (§A of this phase's brief): already
  correct. Distinct S3 state keys, distinct VPC CIDRs
  (`10.0.0.0/16`/`10.1.0.0/16`), distinct `aws_db_instance` resources,
  distinct `verdictvaut/{staging,production}/*` Secrets Manager
  namespaces, distinct root modules/`backend.tf` files. Verified by
  reading every `environments/*/main.tf` side by side.
- **Safe variable defaults / fail-clearly** (§A): already correct.
  Every safety-critical toggle (`deletion_protection`,
  `enable_deletion_protection`) has no default, forcing an explicit
  choice; every account/region/image/domain-shaped variable has no
  default either — grepped for a literal AWS account ID/region outside
  `EXAMPLE ONLY` comments, zero matches.
- **Secrets never hardcoded** (§A): already correct — `modules/secrets`
  creates secret *objects* only; the one deliberate exception
  (`modules/database`'s generated `DATABASE_URL`) is documented inline
  and in `docs/aws-terraform-security-review.md` F3.
- **Network architecture** (§B): already correct — Route53 → ACM →
  public ALB → private ECS → isolated RDS, least-privilege security
  groups, no `0.0.0.0/0` ingress outside the ALB's own listeners, RDS
  `publicly_accessible = false` with an isolated route table. Verified
  by re-reading `modules/network/main.tf` in full.
- **RDS hardening** (§D): already correct — encryption at rest,
  `force_ssl` parameter, automated backups + PITR window, Multi-AZ/
  deletion-protection driven by genuine per-environment variables,
  private networking, restricted security group. Migration strategy
  (`prisma migrate deploy` as a separate gated step, never baked into
  a container's own startup) was already documented and already
  reflected in `apps/api/Dockerfile`'s own comment.
- **ECS container hardening** (§C): already correct — capability
  dropping, non-root user, explicit CPU/memory, `awslogs` logging,
  health checks per service (ALB target-group for web/api, heartbeat-
  file container HEALTHCHECK for the worker).
- **Production safety gates** (§G): already correct and unchanged —
  `production-readiness-check.js`, `ProductionSafetyGate`,
  `ProductionCustodyExecutor`, `ComplianceGateFactory` all re-verified
  this phase to still fail closed exactly as every prior phase left
  them. **Nothing in this phase touches, weakens, or routes around any
  of these.**

## 2. What Phase 28 actually added

### A. A real `terraform` run — two genuine bugs found and fixed

`terraform` was installed locally for the first time in this
repository's history this phase (network access was available; every
prior phase's own environment lacked it). Running the real binary
(`fmt -check -recursive`, `init -backend=false` + `validate` for all
three environments) surfaced two defects no eye-only review across
Phases 25-27 could have caught:

1. Pre-existing `=` alignment drift in 7 files (Phase 27's own G5
   explicitly predicted this and deliberately left it for a real
   `terraform fmt` run to fix) — fixed.
2. **A real, would-have-failed-on-`apply` bug**: 9
   `aws_security_group`/`ingress`/`egress` `description` strings in
   `modules/network/main.tf` used an em-dash or apostrophe, both
   outside the AWS provider's restricted regex for that field —
   `terraform validate` rejected all of them. Fixed by rewording to
   plain ASCII. See `docs/aws-terraform-security-review.md` §4 (H1/H2)
   and `modules/network/main.tf`'s own header note.

All three environments (`staging`, `production`, `shared`) now
validate cleanly end-to-end, including every module this phase added.

### B. `deployment_circuit_breaker` (§C — "failed deployments do not silently become healthy")

`modules/ecs-service` now enables ECS's own deployment circuit breaker
(`enable = true, rollback = true`, on by default) on every service.
Without this, a task definition that never passes its own container
HEALTHCHECK just leaves the service stuck mid-rollout indefinitely,
with old tasks still serving traffic and nothing failing loudly. With
it, ECS itself detects the stuck deployment and rolls back to the last
known-good task definition automatically — paired with a new
EventBridge rule (below) that makes this event visible to a human.

### C. CloudWatch observability layer (§E)

`modules/observability` gained everything
`docs/aws-production-architecture.md` §13/§14 specified since Phase 25
but no prior phase implemented in Terraform — full alarm-by-alarm
mapping is in that document's §14, not duplicated here. Summary:

| Signal category (this phase's brief's own list) | Mechanism |
|---|---|
| API/worker health | ALB `UnHealthyHostCount` alarms (api, web) |
| ECS deployment failures | EventBridge rule on real "ECS Service Action" events (schema verified live against AWS's current docs — `SERVICE_DEPLOYMENT_FAILED`/`SERVICE_TASK_PLACEMENT_FAILURE`/`SERVICE_TASK_CONFIGURATION_FAILURE`) |
| Database connectivity | `aws_db_event_subscription` (failure/low storage/maintenance/recovery categories) |
| Application errors | Log metric filter on `level=error`, elevated-rate alarm (≥20/5min — not single-occurrence, per this phase's own "no noisy alarms" instruction) |
| Blockchain watcher/reconciliation failures | Log metric filters on the real `wallet.deposit_watcher.scan_failed`/`wallet.withdrawal_watcher.*`/`wallet.reconciliation.discrepancy_found`/`settlement.collateral_reconciliation.discrepancy_found` metric names (grepped from source this phase, none invented) |
| Withdrawal/custody failures | Log metric filter on `provider_request_failures_total`/`provider_ambiguous_operations_total` |
| Critical security events | **New**: `auth.account_locked` metric added to `AuthService.login()` (fires once per newly-applied lockout, not per attempt) + a matching alarm — closes a gap `docs/aws-production-architecture.md` §14 had explicitly flagged as "no dedicated metric counter exists today" since before this phase |

Every alarm publishes to one shared SNS topic
(`module.observability.alerts_topic_arn`). **No real subscription is
created** — a human supplies `alarm_email_subscriptions` in a real
`terraform.tfvars` once authorized, matching this repository's
standing "Terraform creates objects, a human wires the real
destination" pattern for every secret value.

**Deliberately not alarmed** (this phase's own "do not create noisy or
useless alarms" instruction): any single error log line, latency (no
traffic baseline exists to pick a safe threshold), rate-limit spikes
(no counter exists yet — a real, separate gap, unchanged).

### D. CI deploy role (§F, closing `docs/aws-iam-and-secrets.md` §2.5's long-standing gap)

New `modules/ci-deploy-role`, instantiated once from `environments/shared`
(account-level, like the ECR registry): a GitHub Actions OIDC provider
+ a role scoped to exactly ECR push on the 3 repos, `ecs:UpdateService`/
`DescribeServices`/`DescribeTaskDefinition`/`RegisterTaskDefinition` on
the 6 real services (3 per environment), and `iam:PassRole` restricted
to exactly the execution + task roles with an
`iam:PassedToService = ecs-tasks.amazonaws.com` condition — never a
wildcard. The OIDC provider's thumbprint was computed this session
from `token.actions.githubusercontent.com`'s real, live certificate
chain (not copied from a possibly-stale memorized value).

### E. Two new GitHub Actions workflows (§F)

Both **`workflow_dispatch`-only** — never triggered by a push to
`main`, matching every prior phase's "production deployment is never
automatic" requirement:

- **`terraform-deploy.yml`**: real `terraform fmt -check` + `init` +
  `plan` against a real backend (distinct from `ci.yml`'s own
  `terraform-validate` job, which always uses `-backend=false` and
  never plans/applies) → uploads the plan artifact → a separate
  `terraform-apply` job, gated behind a `<environment>-infra-apply`
  GitHub Environment, applies **that exact plan file**, never a
  freshly recomputed one.
- **`ecr-publish.yml`**: builds and pushes immutable commit-SHA-tagged
  images for all 3 services → a `production-readiness-check.js` gate
  (production only — staging is expected to use sandbox providers, so
  this check correctly does not apply there) → registers a new task-
  definition revision per service (image tag only, everything else
  Terraform-managed, coexisting via `modules/ecs-service`'s existing
  `lifecycle { ignore_changes = [task_definition] }`) → updates each
  ECS service → waits for all three to reach a steady state (so a
  failed deployment fails the workflow run itself, not just the ECS
  console). An `image_tag` input, when set to a previous commit SHA,
  skips the build and redeploys that exact image unchanged — the
  one-command rollback path `docs/aws-production-change-control.md`
  §3 asked for. A migration step exists in the correct pipeline
  position (before the service updates) but its real `prisma migrate
  deploy` invocation is left as a documented placeholder — seeding a
  real `aws ecs run-task` call with subnet/security-group/task-
  definition ARNs this phase has no AWS account to verify would risk a
  wrong, untested command silently no-op'ing.

**Both workflows will fail immediately, cleanly, at their AWS-credentials
step if run today** — see §3 below for exactly why, by design, not as
an oversight.

## 3. Exact remaining blockers

Nothing below is fixable by more Terraform/CI code from this phase —
each requires either a real AWS account/credential this phase was
never given, or a human decision outside this repository's authority.

1. **No AWS account exists.** Every other blocker below is downstream
   of this one.
2. **No Terraform state backend exists** (the S3 bucket + DynamoDB
   table every `backend.tf` references) — `docs/aws-production-change-control.md`
   §4 step 3.
3. **`AWS_TERRAFORM_ROLE_ARN` and `AWS_CI_DEPLOY_ROLE_ARN` GitHub
   secrets are not set** — the latter's real value doesn't exist until
   `environments/shared` is applied once for real (step 7 of the
   provisioning sequence), a genuine chicken-and-egg ordering
   documented in `docs/aws-production-change-control.md` §4.
4. **No GitHub Environment protection rules are configured** — the
   workflow files reference `<environment>-infra-apply`/
   `<environment>-deploy` by name; a human must create these in GitHub
   Settings with required reviewers before they mean anything.
5. **No region/domain has been chosen** — `docs/aws-region-selection.md`,
   REQUIRES HUMAN APPROVAL.
6. **No real production custody provider** — `ProductionCustodyExecutor`
   unconditionally throws, by design, unchanged.
7. **No real production compliance provider** — `ComplianceGateFactory`
   forces `DeferredComplianceGate` in production, by design, unchanged.
8. **No real production email provider credentials** — `EMAIL_PROVIDER=postmark`
   requires a real, verified-domain production Postmark token; none
   exists.
9. **No managed database backup/HA/PITR provider decision** — local
   `pg_dump` tooling is real and passes its own drill, but is not a
   substitute for RDS-native automated backups actually being live.
10. **The migration step in `ecr-publish.yml` is a documented
    placeholder**, not a real `aws ecs run-task` invocation — see §2E
    above.
11. **Neither new workflow has ever executed against a real AWS
    account** — by construction (none exists) — so neither is
    "tested," only reasoned through and validated for YAML/logic
    correctness.

`production-readiness-check.js` remains the standing, honest gate for
all of #6-9 above — re-run this phase, still correctly exits 1
(BLOCKED), same P0s as every prior phase since none of the underlying
gaps were closed (nor could they be, by this phase's own scope).

## 4. Deployment sequence (pointer, not a duplicate)

The exact 14-step provisioning order remains
`docs/aws-production-change-control.md` §4, extended this phase with
the GitHub secrets/Environments step — not re-derived here.

## 5. Rollback and disaster recovery (pointer, not a duplicate)

- **Application rollback**: `ecr-publish.yml`'s `image_tag` input (§2E
  above) — a real, one-command mechanism now, never executed for real.
- **Infrastructure rollback**: a human-reviewed `terraform plan`
  showing the intended revert, applied through the same
  `terraform-deploy.yml` gate as any other change — no separate
  "infra rollback" tooling exists or is needed beyond that.
- **Database disaster recovery**: `docs/aws-disaster-recovery.md` and
  `docs/production-database-readiness.md` remain authoritative and
  unchanged by this phase.

## 6. Validation performed this phase

See the final phase report for the full command list/output. Summary:
`terraform fmt -check -recursive` clean, `terraform validate` clean
for all 3 environments (first real run in this repository's history),
full backend unit + integration test suites green, frontend test suite
green, both typechecks/lints/builds clean, `production-readiness-check.js`
correctly still BLOCKED (no P0/P1 count regression — this phase added
no new application-level check and removed none).
