# VerdictVaut Terraform — Phase 25 skeleton, hardened through Phase 28

**Status: DESIGNED, NOT APPLIED.** Every file under this directory is
a real specification, and — **as of Phase 28** — has actually been
parsed by a real `terraform` binary (v1.9.8, installed locally this
phase for the first time; `terraform fmt -check -recursive` and
`terraform init -backend=false` + `terraform validate` all pass
cleanly for `staging`/`production`/`shared`, see "Phase 28 additions"
below for what that run actually caught). `terraform plan`/`apply`
have still never been run — that requires a real AWS account and
credentials, still neither obtained nor requested by any phase.
Docker remains unavailable in every session to date (the Dockerfiles'
own long-standing caveat, unrelated to Terraform).

**No `terraform apply` has been, or should be, run using this code
without an authorized AWS account, an explicit go-ahead from the human
operator, and independent review.** No real AWS account ID, credential,
region, or resource identifier appears anywhere in this directory —
every example value is either a Terraform variable or is explicitly
labeled `EXAMPLE ONLY`.

## Why Terraform

Chosen per `docs/production-infrastructure-decision.md`'s Phase 24 IaC
section and this phase's own brief ("prefer Terraform unless repository
evidence strongly supports another choice"). No evidence in this
repository favors an alternative (Pulumi, AWS CDK, raw CloudFormation):
there is no existing IaC of any kind, no team TypeScript-for-infra
precedent beyond this being a TypeScript/Next.js app (which would favor
CDK on stylistic grounds alone, not a technical requirement), and
Terraform's HCL + a plain S3/DynamoDB remote-state backend is the most
widely documented, provider-neutral-enough (in the sense of not tying
the *tooling* itself to AWS, even though the provider config below
does) starting point for a project that has not yet even had its AWS
account created.

## Directory structure

```
infra/terraform/
  README.md                    (this file)
  modules/
    network/                   VPC, subnets, route tables, NAT, security groups
    database/                  RDS instance, subnet group, parameter group
    secrets/                   Secrets Manager secret OBJECTS ONLY (never a value)
    ecs-service/                Reusable module — instantiated 3x per environment
                                (web, api, worker) with different inputs
    observability/             CloudWatch log groups, alarms, SNS topic, RDS event
                                subscription, ECS deployment-failure EventBridge rule (Phase 28)
    alb/                       Application Load Balancer, listeners, target groups, (optional) ACM cert
    iam/                       ECS execution role + per-service task roles
    ecr/                       Container repositories (Phase 27) — see its own header note
                                on why this is a SHARED module, not per-environment
    ci-deploy-role/            (Phase 28) GitHub Actions OIDC provider + CI deploy role
                                — see its own header note on why this is account-level too
  environments/
    staging/                   Wires the modules together for staging
    production/                Wires the modules together for production
                                — a SEPARATE state file from staging, always
    shared/                    (Phase 27, extended Phase 28) Wires module.ecr and
                                module.ci_deploy_role — a THIRD, separate state file,
                                for the resources that legitimately cross the
                                staging/production boundary by design (build-once,
                                promote — docs/aws-deployment-runbook.md §4.2)
```

## State storage and locking design (DESIGNED, NOT PROVISIONED)

Each environment's `backend.tf` specifies an S3 backend with DynamoDB
locking, using variables/placeholders — no real bucket or table name
is created by this phase:

- **Bucket**: one per AWS account (e.g. `verdictvaut-terraform-state`,
  EXAMPLE ONLY), versioning enabled (a corrupted/bad state write is
  recoverable), default encryption enabled, public access blocked.
- **Key**: `<environment>/terraform.tfstate` — `staging/terraform.tfstate`
  and `production/terraform.tfstate` are two distinct objects in the
  same bucket, never a shared key. This is the mechanism that makes
  "a staging `apply` can never touch production" structurally true,
  not just a convention.
- **DynamoDB table**: one shared lock table (e.g.
  `verdictvaut-terraform-locks`, EXAMPLE ONLY) with partition key
  `LockID` — prevents two concurrent `apply` runs (e.g. a human and a
  CI job) from racing on the same state file.
- **Neither the bucket nor the table is created by this phase** — they
  would need to exist (created manually, once, via the AWS CLI/Console,
  or via a small separate "bootstrap" Terraform config with *local*
  state — a well-known chicken-and-egg pattern for remote-state
  backends) before `terraform init` could ever succeed against a real
  backend. `backend.tf` in each environment directory documents this
  with real Terraform syntax but placeholder names, commented as
  requiring the bucket/table to exist first.

## Safety defaults applied throughout

- **`deletion_protection = true`** on the production RDS instance,
  driven by a genuine per-environment Terraform variable
  (`var.deletion_protection`, `false` for staging so it can actually be
  torn down) — this is the real, working, per-environment safety
  mechanism this design relies on.
- **Terraform's own `prevent_destroy` lifecycle meta-argument is
  deliberately NOT used** in `modules/database` — it is a hard HCL
  constraint that `prevent_destroy` cannot be set from a variable, so a
  single shared module cannot safely vary it between staging (which
  must be destroyable) and production without either duplicating the
  resource or hardcoding a value that would also block staging
  teardown. `modules/database/main.tf` documents this tradeoff inline.
  If a Terraform-level `prevent_destroy` is wanted for production
  specifically, the production environment root module should declare
  that resource directly instead of through the shared module — not
  done in this skeleton, since AWS's own `deletion_protection` already
  provides the real protection and duplicating the whole resource for
  one extra guard was judged not worth the duplication.
- **No secret *value* is ever set via Terraform for any provider
  credential** — `modules/secrets` creates the `aws_secretsmanager_secret`
  object only; a human (or a separate, more tightly-scoped process)
  sets the actual JWT/Fireblocks/Elliptic/Postmark secret values
  out-of-band via the AWS Console or CLI. **The one deliberate
  exception is the database credential**: `modules/database` generates
  the RDS master password itself (`random_password`) and stores a
  fully-composed `DATABASE_URL` connection string in Secrets Manager —
  chosen over RDS's native `manage_master_user_password` feature
  specifically because that feature stores a JSON `{username,
  password}` object, not a single connection string, and this
  codebase's `env.validation.ts` expects one plain `DATABASE_URL`
  value; using the native feature as-is would require an application
  code change (an entrypoint script assembling the URL from JSON) that
  this infra-only phase does not make. See
  `modules/database/main.tf`'s own "CREDENTIAL DESIGN NOTE" for the
  full reasoning. The database password therefore does live in
  Terraform state — the S3 backend's `encrypt = true` and the state
  bucket's own access controls are its real protection, same as any
  Terraform-managed credential.
- **Staging and production are separate root modules with separate
  state** (`environments/staging` vs. `environments/production`) —
  never one root module with an `environment` variable toggling
  between two states. This is deliberate: a single shared root module
  makes it possible to `apply` against the wrong workspace by mistake;
  two entirely separate directories with their own backend
  configuration make that mistake require actively `cd`-ing into the
  wrong directory, a much harder failure mode to hit accidentally.
- **Variables, not literals**, for region/account/environment
  throughout — grep this entire directory for a literal AWS account ID
  or region string outside of comments explicitly marked `EXAMPLE
  ONLY`; there should be none.

## How this would actually be used (once authorized — not done in this phase)

```
cd infra/terraform/environments/staging
terraform init      # requires the S3 bucket/DynamoDB table above to already exist
terraform plan       # requires real AWS credentials (e.g. via AWS SSO/OIDC) —
                      # this phase could not run this even if it wanted to, since
                      # no AWS account/credential exists
terraform apply       # NEVER run by this phase, and never without human review
                       # of the plan output first
```

## What this phase explicitly did NOT do

- Did not run `terraform init`, `plan`, `validate`, `fmt`, or `apply`
  (tool not installed; no AWS account exists regardless).
- Did not create the S3 state bucket or DynamoDB lock table.
- Did not create any AWS resource.
- Did not write a real account ID, credential, or region anywhere in
  this directory.

## Phase 27 additions

**Status unchanged: DESIGNED, NOT APPLIED, `terraform` still not
installed in this development environment** (re-confirmed this
session). What changed:

- **`modules/ecr`** (new) + **`environments/shared`** (new) — the 3
  container repositories (immutable tags, scan-on-push, lifecycle
  policy — closing the gap that `docs/aws-deployment-runbook.md` §3
  had specified since Phase 25 but no Terraform code had ever
  implemented). Deliberately a third root module/state, not part of
  either `environments/staging` or `environments/production` — see
  `modules/ecr/main.tf`'s header note for why a build-once/promote
  pipeline needs one shared registry, not two.
- **`modules/alb`**: `enable_deletion_protection` is now a required
  variable (no default) — the same "no unsafe default on a
  safety-critical toggle" treatment `docs/aws-terraform-security-review.md`
  F2 already applied to `modules/database`'s `deletion_protection`,
  extended to the ALB. `true` in production, `false` in staging.
- **`modules/ecs-service`**: every container definition now drops all
  Linux capabilities (`linuxParameters.capabilities.drop = ["ALL"]`,
  unconditional — Fargate has no `privileged` mode to worry about
  separately, and none of web/api/worker's non-root Node.js processes
  need any capability). `read_only_root_filesystem` is a new **opt-in,
  default-false** variable (with a `/tmp` tmpfs mount wired in
  automatically when enabled, for the worker's heartbeat file) — left
  off by default because it has not been verified against a real
  running container (Docker unavailable in every session to date).
- CI (`.github/workflows/ci.yml`) gained a `terraform-validate` job:
  `terraform fmt -check -recursive`, then `terraform init -backend=false`
  + `terraform validate` for each of `staging`/`production`/`shared`.
  No AWS credential is configured in CI — `-backend=false` means it
  never attempts to reach the real (nonexistent) S3/DynamoDB backend.
  This is the first time any of this Terraform code will actually be
  parsed by a real `terraform` binary — previously it was reviewed by
  eye only (`docs/aws-terraform-security-review.md` §0).

## Phase 28 additions

**`terraform` was installed locally for the first time this phase**
(v1.9.8, matching CI's pinned version — network access was available
in this session's environment; downloaded from HashiCorp's own
releases server) and run for real: `terraform fmt -check -recursive`,
then `terraform init -backend=false` + `terraform validate` for
`staging`, `production`, and `shared`. This immediately surfaced two
real, previously-undetectable defects that six prior phases of
eye-only review had missed:

1. **Formatting drift** (7 files) — pre-existing `=` alignment
   inconsistencies Phase 27 explicitly predicted and deliberately left
   unfixed pending a real `terraform fmt` run (`docs/aws-terraform-security-review.md`
   G5). Fixed by actually running `terraform fmt -recursive`.
2. **A real `terraform validate` failure in `modules/network`**: every
   `aws_security_group`/`ingress`/`egress` `description` field using an
   em-dash or apostrophe violated the AWS provider's own restricted
   regex for that argument (`^[0-9A-Za-z_ .:/()#,@\[\]+=&;{}!$*-]*$`) —
   9 occurrences across all 5 security groups. This would have failed
   the very first real `terraform apply` of the network module against
   a real AWS account; no prior static review could have caught it
   (`terraform validate` is the only tool that checks provider-schema
   string-format constraints). Fixed by rewording all 9 to plain ASCII
   — see `modules/network/main.tf`'s own header note.

All three environments (`staging`, `production`, `shared`) now
validate cleanly end-to-end, including every module added this phase.

New this phase, all still **DESIGNED, NOT APPLIED**:

- **`modules/observability`** gained the CloudWatch Alarms/SNS/RDS-event-
  subscription/EventBridge layer `docs/aws-production-architecture.md`
  §13/§14 specified since Phase 25 but no prior phase implemented in
  Terraform — see that module's own header note and
  `docs/aws-production-architecture.md` §14 for the full alarm-by-alarm
  mapping. Every log-based filter pattern matches the real JSON shape
  `JsonLoggerService`/`LoggingMetricsService` actually emit (re-read
  this phase); every metric name matches a real `metrics.increment(...)`
  call site (grepped this phase, none invented). One new application
  metric was added to close a real, previously-flagged gap:
  `auth.account_locked` (`apps/api/src/auth/auth.service.ts`, fires
  once per newly-applied account lock).
- **`modules/ecs-service`** gained `deployment_circuit_breaker` (default
  **on**, `enable = true, rollback = true`) — the concrete mechanism
  behind "failed deployments do not silently become healthy": ECS
  itself now detects a deployment that can never reach a steady state
  and rolls back automatically, surfaced to the new SNS topic via
  `modules/observability`'s EventBridge rule.
- **`modules/ci-deploy-role`** (new) + `environments/shared` extension —
  implements `docs/aws-iam-and-secrets.md` §2.5's CI/CD deploy role
  (GitHub OIDC provider + a role scoped to exactly ECR push + the 3 ECS
  services' `UpdateService`/`DescribeServices`/`DescribeTaskDefinition`/
  `RegisterTaskDefinition` + a narrowly-scoped `iam:PassRole`), which
  that document had explicitly deferred as "not created or used by this
  phase" since Phase 25. The OIDC provider's thumbprint was computed
  THIS SESSION from `token.actions.githubusercontent.com`'s real live
  certificate chain, not copied from a possibly-stale memorized value
  (see that module's own comment).
- **`.github/workflows/terraform-deploy.yml`** (new) — `workflow_dispatch`-only
  real `terraform plan`/`apply` against a real backend (distinct from
  `ci.yml`'s own `terraform-validate` job, which always uses
  `-backend=false` and never plans/applies). `apply` is a separate job
  gated behind a GitHub Environment (`<environment>-infra-apply`) a
  human must configure with required reviewers.
- **`.github/workflows/ecr-publish.yml`** (new) — `workflow_dispatch`-only
  build+push of immutable commit-SHA-tagged images, a
  `production-readiness-check.js` gate (production only, before
  deploy), then an ECS task-definition-revision update per service,
  gated behind `<environment>-deploy`. An `image_tag` input, when set
  to a previous SHA, skips the build and redeploys that exact image —
  the one-command rollback path `docs/aws-production-change-control.md`
  §3 asked for.

**Both new workflows will fail immediately at their AWS-credentials
step today** — the `AWS_TERRAFORM_ROLE_ARN`/`AWS_CI_DEPLOY_ROLE_ARN`
GitHub secrets they reference are not set anywhere, and no AWS account
exists regardless. This is the correct, honest state, not a bug to
fix: `docs/aws-production-change-control.md` §4 documents exactly what
must happen first.
