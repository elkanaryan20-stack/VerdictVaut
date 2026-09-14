# AWS Production Change Control — Phase 26, extended Phase 27

**Status: DESIGNED, NOT PROVISIONED, NOT IMPLEMENTED AS AUTOMATION.**
No CI/CD deployment pipeline, deployment role, or protected environment
exists — `.github/workflows/ci.yml` gained a Terraform *validation*
job this phase (`docs/aws-terraform-security-review.md` "CI Terraform
validation"), but it builds/tests/validates only, never deploys, never
holds an AWS credential, and never runs `plan`/`apply` (re-verified
this session by reading the full workflow). This document defines the
guardrails a real production deployment pipeline must have before it
is ever built, so that building it later is a matter of implementing
an already-agreed design, not inventing safety controls under time
pressure.

## 1. Guardrails against accidental production deployment

| Guardrail | Design | Status |
|---|---|---|
| Separate AWS account/environment | `docs/aws-account-governance.md` §1 — a dedicated production account (recommended) is the strongest guardrail: an accidental `terraform apply`/`aws ecs update-service` against the wrong target requires actively assuming different credentials, not just picking a different CLI flag | **REQUIRES HUMAN APPROVAL** (account creation) |
| Separate Terraform state | `infra/terraform/environments/{staging,production}` — distinct backend state keys (`staging/terraform.tfstate` vs. `production/terraform.tfstate`), distinct root modules, distinct `terraform.tfvars` — re-confirmed this session by reading both `backend.tf` files | DESIGNED, IMPLEMENTED IN CODE, NOT YET BACKED BY A REAL REMOTE BACKEND |
| Manual production approval | `docs/aws-deployment-runbook.md` §4.2's pipeline design — production deployment is gated behind a human-reviewed approval step (e.g. GitHub Environments' "required reviewers"), never automatic on merge to `main` | DESIGNED, NOT IMPLEMENTED — no pipeline stage past build/test exists to gate |
| Explicit production variable | Every environment's `APP_ENVIRONMENT` is set explicitly per ECS task definition (`environments/production/main.tf`: `APP_ENVIRONMENT = "production"`; `environments/staging/main.tf`: `APP_ENVIRONMENT = "sandbox"`) — never inferred, never defaulted, never shared between the two `main.tf` files | DESIGNED, IMPLEMENTED IN CODE |
| Protected CI environment | GitHub Environments (or equivalent) with required reviewers + a restricted set of principals allowed to trigger a production deploy — the natural mechanism, not independently verified against GitHub's current documentation this session since no pipeline exists yet to configure it against | DESIGNED, NOT IMPLEMENTED |
| Restricted deployment role | `docs/aws-iam-and-secrets.md` §2.5 — the CI deploy role is scoped to exactly the 3 ECR repos + the 3 ECS services + a narrowly-scoped `iam:PassRole` (never `PassRole` on `*`) — no broader permission | DESIGNED, NOT PROVISIONED (no OIDC provider, no role, no AWS account) |
| Immutable image SHA | `docs/aws-deployment-runbook.md` §3 — ECR repositories designed with `imageTagMutability: IMMUTABLE`; every image tagged with the full commit SHA it was built from, never `latest` as the deployment target | DESIGNED, IMPLEMENTED IN CODE this phase (`infra/terraform/modules/ecr`, `environments/shared`) — **still NOT PROVISIONED**, no ECR repository exists |
| Production ALB deletion protection | `infra/terraform/modules/alb`'s `enable_deletion_protection` (Phase 27, `docs/aws-terraform-security-review.md` G1) — `true` in `environments/production`, `false` in staging | DESIGNED, IMPLEMENTED IN CODE, NOT YET PROVISIONED |
| Migration safety gate | The existing `guard-destructive-migration.js` (unchanged, re-verified this session) plus the "migration first, as its own step, before any image rollout" sequencing in `docs/aws-deployment-runbook.md` §4.2 and `docs/production-deployment-plan.md` §6 | IMPLEMENTED IN APPLICATION CODE (the guard script), DESIGNED (the sequencing) |
| Production-readiness gate | `apps/api/scripts/production-readiness-check.js` — **unchanged this phase, still correctly BLOCKED** (§`docs/aws-terraform-security-review.md` doesn't touch it; see this phase's Production Readiness section in the final report) | IMPLEMENTED, RE-VERIFIED THIS SESSION |

## 2. This phase does not implement a bypass

**No guardrail listed above was relaxed, and no new mechanism was
built that could route around `production-readiness-check.js`,
`ProductionSafetyGate`, `ProductionCustodyExecutor`, or
`ComplianceGateFactory`.** Specifically verified this session by
re-reading each:

- `production-readiness-check.js` still exits 1 (BLOCKED) with the
  same P0/P1 failures as every prior phase — this phase added no new
  check and removed none.
- `ProductionSafetyGate.onApplicationBootstrap()` still throws for
  `APP_ENVIRONMENT=production` unless a real (non-`DeferredComplianceGate`)
  compliance gate is bound **and** real, enabled PRODUCTION-environment
  provider config rows exist — unchanged.
- `ProductionCustodyExecutor.execute()` still unconditionally throws —
  unchanged.
- The Terraform skeleton's `environments/production/main.tf` sets
  `APP_ENVIRONMENT = "production"` in the task definition it *would*
  deploy if ever applied — this does not, and cannot, change what
  happens when that container actually boots; the application-level
  gates above run regardless of which infrastructure launched the
  container.

**A future CI/CD pipeline must not be built to "make production
readiness pass"** — if a real pipeline stage ever finds itself
blocked by `production-readiness-check.js`, the correct response is to
close the underlying gap (real custody/compliance/email/backup
infrastructure), never to skip or weaken the check. This is a
restatement of a standing principle from every prior phase (Phase 13
onward), not a new rule invented here.

## 3. What a real future CI/CD deployment stage must additionally enforce (DESIGNED, NOT BUILT)

1. **`production-readiness-check.js --with-db` must exit 0** before a
   production deployment proceeds — today this is impossible (P0
   custody/compliance failures are structural, not environmental), and
   the pipeline should fail closed on that, not skip the check.
2. **The Terraform plan for `environments/production` must be reviewed
   by a human** before `apply` — no CI job should run
   `terraform apply` unattended against production, ever, regardless
   of how much other automation exists upstream of it.
3. **A migration, if present in the changeset, must run and succeed as
   its own gated step** before the ECS service update — matching
   `docs/aws-deployment-runbook.md` §4.2's pipeline order (migration →
   API → worker → web), never bundled into the same deploy action as
   the application rollout.
4. **Rollback path must be tested**, not just designed — restated from
   `docs/production-deployment-plan.md` §7 (redeploy the previous
   immutable image tag; a migration is never auto-rolled-back) — a
   real pipeline should make "redeploy the last known-good SHA" a
   one-command action, not a manual multi-step recovery under
   pressure.

## 4. Provisioning sequence (Phase 27 addition — a PLAN, not execution)

**Nothing below has been executed by this phase or any prior phase.**
This is the exact order a human operator would follow once every
`REQUIRES HUMAN APPROVAL` decision referenced throughout
`docs/aws-*.md` has actually been made — restated here as a single
ordered checklist because no prior document collected it into one
place. Each step names the document that specifies it; none of those
documents' own content changes as a result of listing it here.

1. **AWS account governance** — create the account(s) (`docs/aws-account-governance.md`
   §1), enable root MFA + break-glass procedure (§2/§3), set up IAM
   Identity Center for human access (§4), enable CloudTrail (§5), AWS
   Budgets + Cost Anomaly Detection (§6, `docs/aws-cost-governance.md`
   §4's checklist).
2. **Region approval** — a human accepts, overrides, or rejects the
   `us-east-1` recommendation in `docs/aws-region-selection.md` §2
   based on the data-residency/user-geography criteria that document
   cannot evaluate on its own.
3. **Terraform state backend** — manually (or via a small separate
   bootstrap config with local state, per `infra/terraform/README.md`'s
   "State storage and locking design") create the S3 bucket
   (versioned, encrypted, public access blocked) and DynamoDB lock
   table referenced by every `backend.tf`/`environments/shared/backend.tf`
   in this repository — this is the prerequisite every `EXAMPLE ONLY`
   bucket/table placeholder in this codebase depends on; `terraform
   init` cannot succeed against a real backend before this step.
4. **VPC/network** — `terraform apply` against `environments/{staging,production}`'s
   `module.network` only (or the full environment, network resources
   have no dependency on anything provisioned later) — per
   `docs/aws-network-design.md`.
5. **RDS** — `module.database`, per `docs/aws-disaster-recovery.md` §1
   — requires a real, measured `db_instance_class` decision first
   (`docs/aws-cost-governance.md` §1's own flag that no load test has
   ever been run).
6. **Secrets** — `module.secrets` creates the secret OBJECTS; a human
   sets every real secret VALUE out-of-band via the AWS Console/CLI
   immediately after (`docs/aws-iam-and-secrets.md` §3/§7) — Terraform
   itself never sets a secret value except the database module's own
   generated password (§`infra/terraform/modules/database/main.tf`'s
   credential design note).
7. **ECR** — `terraform apply` against the new `environments/shared`
   (Phase 27) — a one-time step, independent of and prior to any
   staging/production `apply` that references its output via
   `terraform_remote_state` (§`docs/aws-terraform-security-review.md`
   G2).
8. **ECS** — cluster + the 3 services per environment
   (`module.ecs-service` ×3, `docs/aws-deployment-runbook.md` §1) —
   requires a real image already pushed to the ECR repositories from
   step 7 (`var.web_image`/`api_image`/`worker_image` have no default).
9. **ALB/ACM/DNS** — `module.alb` (§`docs/aws-deployment-runbook.md`
   §2), which requires the domain/region decision from step 2 and a
   validated ACM certificate before the HTTPS listener can attach to
   any target group.
10. **Observability** — `module.observability`'s log groups (already
    provisioned as part of steps 4-8's `apply`, called out separately
    here only because CloudWatch Alarms/dashboards, §`docs/aws-production-architecture.md`
    §13/§14, remain a deliberately separate, not-yet-designed follow-up
    once a human authorizes real alerting).
11. **Staging deployment** — the full sequence above applied to
    `environments/staging` first, always — `environments/production`
    is never the first environment a new piece of infrastructure is
    applied to.
12. **Staging validation** — real Fireblocks/Elliptic sandbox smoke
    tests (`docs/fireblocks-sandbox-smoke-test.md`, never actually run
    in any session to date — §`docs/aws-production-architecture.md`
    §11's "sandbox today" framing), `production-readiness-check.js
    --with-db` run against the real staging database, a real restore
    drill against a disposable staging RDS snapshot
    (`docs/aws-disaster-recovery.md` §4's "NOT YET POSSIBLE — no RDS
    instance exists" row, resolved for staging specifically).
13. **Production approval** — a human-reviewed `terraform plan` for
    `environments/production` (§3 item 2 above), plus every other
    `REQUIRES HUMAN APPROVAL` decision this phase's brief and every
    `docs/aws-*.md` document already flagged (account, region, go-live,
    real custody/compliance/email production credentials) — collected,
    never re-decided, here.
14. **Production deployment** — only after step 13, and only through
    the manual-approval-gated pipeline design in §1 above/`docs/aws-deployment-runbook.md`
    §4.2 — never a direct `terraform apply` run ad hoc by an individual
    outside that gate.

**This sequence is a plan. No step has been executed.** Steps 1-3 are
prerequisites for steps 4-10 to even be plannable against a real
backend; steps 11-12 (staging) must fully succeed, independently
validated, before step 13 (production approval) is sought — restated
because this phase's brief specifically requires this order to be
explicit, not left implicit across several documents.

The new `terraform-validate` CI job (`docs/aws-terraform-security-review.md`
"CI Terraform validation") sits entirely before step 3 above in
practice — it runs on every push/PR against this repository's source
today, with no AWS credential and `-backend=false`, so it validates
syntax/internal-consistency continuously but plays no role in, and
adds no capability toward, any step 3-14 action. It is not, and must
never become, a gate that runs `terraform plan`/`apply` against a real
backend from CI.

## 5. What this document does not do

- Does not create a GitHub Environment, protection rule, or CI/CD
  workflow file.
- Does not create an IAM role, OIDC provider, or ECR repository.
- Does not weaken `production-readiness-check.js` or any application-
  level safety gate — every one was re-verified unchanged this
  session, not merely assumed unchanged from memory.
