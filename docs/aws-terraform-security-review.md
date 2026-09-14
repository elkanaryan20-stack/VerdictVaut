# AWS Terraform Security Review — Phase 26

**Status: DESIGNED, NOT APPLIED, NOT PROVISIONED.** A full static
review of every file under `infra/terraform/` (38 files, all read in
full this session — not sampled or assumed from Phase 25's own
descriptions). No AWS resource exists; this review is of source code
only.

## 0. Tooling status

`terraform` is **not installed** in this development environment —
re-confirmed this session (`terraform -version` fails identically in
both Git Bash and PowerShell: "command not found" / not recognized).
Per this phase's explicit instruction, it was **not installed
automatically**. Consequently:

- `terraform fmt -check -recursive` — **NOT RUN**
- `terraform validate` — **NOT RUN** (this also requires `terraform
  init`, which would attempt to download provider plugins — not
  attempted)
- `terraform plan` — **NOT RUN**, and would additionally require real
  AWS credentials this session does not have and was told not to
  obtain

**What was done instead — static review only**: every `.tf` file was
read in full; a brace-balance check confirmed no file is structurally
truncated; every module input/output reference was cross-checked
against the module that defines it (all resolve correctly — no
reference to an output or variable that doesn't exist). **This is not
a substitute for a real `terraform validate` run** — it cannot catch
provider-schema-level errors (a typo'd argument name, an invalid
attribute combination `terraform validate` would reject) the way the
real tool would. A human or CI environment with Terraform installed
must run the three commands above before this code is trusted for a
real `plan`.

## 1. Findings

Each finding is graded CRITICAL / HIGH / MEDIUM / LOW /
INFORMATIONAL, per this phase's own checklist categories.

### MEDIUM — Fixed this session

**F1. No `.gitignore` coverage for Terraform artifacts.**
`infra/terraform/` held real, usable module code with no corresponding
`.gitignore` entries for `.terraform/` (provider plugin cache),
`*.tfstate`/`*.tfstate.*` (would contain the plaintext DB password if
anyone ever ran `terraform apply` against a local backend, even
temporarily), or a filled-in `terraform.tfvars` (distinct from the
committed `*.tfvars.example` files). A human running `terraform init`/
`plan` locally before a remote backend is configured could have
accidentally `git add`ed a real state file or credential-bearing
tfvars. **Fixed**: root `.gitignore` now excludes `**/.terraform/`,
`*.tfstate*`, `*.tfplan`, `*.tfvars`/`*.tfvars.json` (while explicitly
un-ignoring `*.tfvars.example`), and Terraform crash logs/override
files. `.terraform.lock.hcl` is deliberately **not** ignored — it
should be committed for reproducible provider version resolution.

**F2. `deletion_protection` had an unsafe default at the module
level.** `modules/database/variables.tf` declared `variable
"deletion_protection" { default = false }`. Both `environments/staging`
(`false`) and `environments/production` (`true`) already override this
explicitly, so no real exposure exists today — but a safety-critical
toggle defaulting to the *less* protective value is exactly the "unsafe
default" category this phase's brief asks to check for: a future
environment, or a copy-paste of the production block that drops one
line, would silently deploy without deletion protection instead of
failing to plan at all. **Fixed**: the `default` was removed — the
variable is now required, forcing every caller (including any future
one) to make an explicit, conscious choice. Terraform will refuse to
plan without it, which is the correct failure mode for a safety gate.

### LOW / INFORMATIONAL — documented, not code-changed

**F3. The database master credential lives in Terraform state in
plaintext.** `modules/database` generates the RDS password via
`random_password` and stores a fully-composed `DATABASE_URL` string in
Secrets Manager — a deliberate design choice (documented in that
module's own "CREDENTIAL DESIGN NOTE") made because RDS's native
`manage_master_user_password` feature stores a `{username, password}`
JSON object incompatible with this codebase's single-connection-string
`DATABASE_URL` expectation, and fixing that would require an
application code change out of scope for an infra-only phase. The
practical consequence: the real password value exists in Terraform
state (`terraform.tfstate`), not just in AWS. **This is not fixable by
Terraform code alone** — it is a property of managing any database
credential via Terraform at all, standard practice, and the reason
`docs/aws-terraform-security-review.md` §5 (below) and
`infra/terraform/README.md` both insist on an encrypted, access-
restricted remote state backend as non-negotiable. Residual risk:
**real** until that backend is actually provisioned with the access
controls documented in §5 — today, this is a specification, not an
enforced control.

**F4. No customer-managed KMS key for CloudWatch Logs or Secrets
Manager.** Both currently rely on AWS-owned default encryption keys.
AWS encrypts both services at rest by default regardless, so this is
not a "missing encryption" finding — but a customer-managed key would
give the account owner independent rotation/revocation/access-logging
control (e.g. via CloudTrail data events on the key itself). Optional
hardening, not a launch blocker; not added this phase since it would
be guessing at a KMS key-management policy this repository has no
authority to decide.

**F5. `nat_gateway_per_az` (network module) and `multi_az` (database
module) also default to `false` at the module level**, the same shape
of issue as F2 but judged lower severity: both are cost/availability
tradeoffs rather than hard security controls, and — like F2 before its
fix — both are already explicitly overridden by both real environment
configurations. Not code-changed this session to avoid unnecessary
churn on a non-safety-critical toggle; flagged here so a future
reviewer can apply the same "no default" treatment if judged worth it.

**F6. No S3 bucket for ALB access logs.** Already labeled OPTIONAL in
`docs/aws-production-architecture.md` §9 and un-created by design
(`modules/alb`'s own comment) — restated here, not a new finding.

### Reviewed and found NOT to be a problem

- **`ecr:GetAuthorizationToken` granted on resource `"*"`**
  (`modules/iam/main.tf`) — this is a genuine AWS API constraint (the
  action has no resource-level ARN it can be scoped to), not a
  least-privilege violation. Every other IAM statement in this
  codebase's Terraform is scoped to specific ARNs passed in as
  variables.
- **No `AdministratorAccess`, `PowerUserAccess`, or any wildcard
  `actions = ["*"]` anywhere** — grepped across all 38 files, zero
  matches beyond the justified case above.
- **No `0.0.0.0/0` ingress anywhere except the ALB's own 443/80
  listeners** (`modules/network/main.tf`) — grepped every occurrence
  of `0.0.0.0/0` in the tree; every other instance is either an egress
  rule (web/API/worker tasks reaching the internet via NAT — required
  for legitimate third-party calls) or a public-subnet route table's
  Internet Gateway route (required for the ALB itself).
- **RDS**: `publicly_accessible = false` (explicit, not relying on a
  default), `storage_encrypted = true`, isolated subnet group with no
  internet route in either direction, security group ingress scoped to
  exactly the API and worker task security groups (no other principal),
  `force_ssl = 1` parameter.
- **Worker task security group has no `ingress` block at all** —
  confirmed by reading the resource definition directly, not inferred.
- **No ECS task has `assign_public_ip = true` anywhere** — grepped;
  the single occurrence in the codebase is hardcoded `false` with an
  explanatory comment.
- **No hardcoded AWS account ID, credential, private key, or literal
  secret value anywhere** — grepped for 12-digit account-ID-shaped
  strings, `arn:aws:...:<digits>:` patterns, and literal
  `password = "..."`/`secret_string = "..."` assignments; zero matches
  outside variable references and explicitly `EXAMPLE ONLY`-labeled
  placeholder strings in `.tfvars.example` files (which are meant to be
  committed, unlike real `.tfvars`).
- **No hardcoded region outside `EXAMPLE ONLY`-labeled comments/example
  files** — every real `aws_region`/`availability_zones` value is a
  required Terraform variable with no default.
- **Staging and production share no state, network, database, or
  secret namespace** — separate S3 state keys (`staging/terraform.tfstate`
  vs. `production/terraform.tfstate`), separate VPC CIDRs
  (`10.0.0.0/16` vs. `10.1.0.0/16`), separate `aws_db_instance`
  resources, separate `verdictvaut/staging/*` vs.
  `verdictvaut/production/*` Secrets Manager namespaces. Confirmed by
  reading both `environments/*/main.tf` side by side.
- **No Terraform output exposes a secret value** — every
  `database_url_secret_arn`-shaped output returns an ARN (not
  sensitive) or a non-secret endpoint/identifier; grepped for the raw
  `random_password.master.result` or `secret_string` appearing in any
  `outputs.tf` — zero matches.
- **CI workflow (`.github/workflows/ci.yml`) and both Dockerfiles**
  re-grepped this session for `AWS_ACCESS_KEY`/`AWS_SECRET`/`secrets.*`
  AWS references and for any `SECRET`/`PASSWORD`/`TOKEN`/`PRIVATE_KEY`-
  shaped literal — zero matches beyond the pre-existing, unchanged
  comments describing the deliberate absence of baked-in secrets.

## 2. Summary table

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | No `.gitignore` coverage for Terraform state/tfvars/cache | MEDIUM | **Fixed this session** |
| F2 | `deletion_protection` unsafe module-level default | MEDIUM | **Fixed this session** |
| F3 | DB credential lives in Terraform state plaintext | LOW/INFORMATIONAL | Documented — inherent to the design, mitigated only by remote-state access controls (§`docs/aws-terraform-security-review.md` §... see `infra/terraform/README.md`), not yet enforced (no backend exists) |
| F4 | No customer-managed KMS key for Logs/Secrets Manager | LOW/INFORMATIONAL | Documented, optional hardening |
| F5 | `nat_gateway_per_az`/`multi_az` unsafe-default pattern (lower severity than F2) | LOW/INFORMATIONAL | Documented, not code-changed |
| F6 | No ALB access-log S3 bucket | LOW/INFORMATIONAL | Restated from Phase 25, already labeled OPTIONAL |
| G1 | ALB `enable_deletion_protection` unsafe default (no argument at all → AWS default `false`) | MEDIUM | **Fixed — Phase 27** |
| G2 | No Terraform module implemented ECR's documented hardening config | MEDIUM | **Fixed — Phase 27** (`modules/ecr` + `environments/shared`) |
| G3 | ECS container definitions didn't drop Linux capabilities | LOW | **Fixed — Phase 27** |
| G4 | `read_only_root_filesystem` not available/designed | INFORMATIONAL | **Added — Phase 27**, opt-in, default off (unverified against a real container) |

**No CRITICAL or HIGH finding was identified, this phase or Phase 26.**
Nothing in either review required reducing any existing safety control
to "pass" — every fix (F1/F2, G1-G3) added protection or closed a
genuine code-completeness gap, never relaxed an existing one.

## 3. Phase 27 — independent re-verification and additions

**Status: DESIGNED, NOT APPLIED, NOT PROVISIONED — unchanged.** Phase
26's own uncommitted work (this document, `docs/aws-account-governance.md`,
`docs/aws-cost-governance.md`, `docs/aws-region-selection.md`,
`docs/aws-production-change-control.md`, the `.gitignore`/`variables.tf`
F1/F2 fixes) was found sitting **uncommitted** in the working tree at
the start of this phase — re-verified via `git status`/`git log`, not
assumed. Per this phase's own "do not commit until approved"
instruction, it remains uncommitted; this phase built on top of it
rather than duplicating it, consistent with this project's standing
"inspect first, don't redo a completed phase" practice.

Every one of Phase 26's F1-F6 findings and "reviewed and found not to
be a problem" claims was independently re-read against the current
source this session (all 30 `.tf` files existing at the start of this
phase, read in full — not resampled from Phase 26's own summary) and
**confirmed accurate**: the `.gitignore` Terraform coverage is correct
and in place; `modules/database/variables.tf`'s `deletion_protection`
has no default; `nat_gateway_per_az`/`multi_az` still default `false`
at the module level (F5, still not code-changed, same reasoning);
no `0.0.0.0/0` ingress exists anywhere except the ALB's own listeners;
no wildcard IAM action/resource exists outside the justified
`ecr:GetAuthorizationToken` case; RDS is `publicly_accessible = false`
with an isolated subnet group and `force_ssl = 1`; the worker security
group has no ingress block; no ECS task ever sets
`assign_public_ip = true`; no hardcoded account ID, credential, or
region exists outside `EXAMPLE ONLY`-labeled placeholders; staging and
production share no state, network, database, or secret namespace; no
Terraform output exposes a secret value.

`terraform` remains **not installed** in this development environment
(re-confirmed this session, identical to Phase 26's own finding) — the
three commands below still could not be run locally:

- `terraform fmt -check -recursive infra/terraform` — **NOT RUN**
- `terraform init -backend=false` / `terraform validate` — **NOT RUN**
  locally (see "CI Terraform validation" below for what CI now does
  instead)
- `terraform plan` — **NOT RUN**, would additionally require real AWS
  credentials this session does not have and was told not to obtain

### New findings and additions this phase

**G1 (MEDIUM, fixed this session).** The ALB (`modules/alb`) had no
`enable_deletion_protection` argument at all — AWS's own default for
`aws_lb` is `false`, meaning the same "unsafe default on a
safety-critical toggle" shape as F2, just on a different resource
(nothing before this phase would stop an accidental
`terraform destroy`/console deletion of the production load balancer).
**Fixed**: `enable_deletion_protection` is now a required variable
(no default, same treatment as F2), `true` in production, `false` in
staging.

**G2 (MEDIUM, fixed this session).** `docs/aws-deployment-runbook.md`
§3 has specified ECR's exact hardening configuration (immutable tags,
scan-on-push, lifecycle policy) since Phase 25, but no Terraform module
ever implemented it — `modules/iam`'s `ecr_repository_arns` was wired
to a hardcoded `[]` in both environments with a comment stating no
repository exists, which was true of the AWS resource but had become
misleading about the *Terraform code's* own completeness. **Fixed**: a
new `modules/ecr` module (immutable tags, scan-on-push,
AES256-encrypted, untagged-image + tagged-image-count lifecycle
policy) wired from a new `environments/shared` root module — kept
deliberately separate from `environments/staging`/`environments/production`
because the deployment pipeline's build-once/promote model
(`docs/aws-deployment-runbook.md` §4.2) requires one shared registry,
not a duplicate pair that could silently diverge for the "same"
commit-SHA tag. `environments/{staging,production}/main.tf` now read
the registry's ARNs via a `terraform_remote_state` data source rather
than a hardcoded `[]` — that data source cannot resolve until the same
real S3/DynamoDB backend every environment's own `backend.tf` already
requires exists, so this is a code-completeness fix, not a claim that
anything is newly provisioned.

**G3 (LOW, fixed this session).** `modules/ecs-service`'s container
definitions never set `linuxParameters.capabilities`, leaving every
container at Docker's default capability set — unnecessary for any of
web/api/worker's non-root, non-privileged-port Node.js processes.
**Fixed**: `linuxParameters.capabilities.drop = ["ALL"]` unconditionally
on all three services. (Fargate itself has no `privileged` container
mode to separately guard against — verified against this module's own
`aws_ecs_task_definition`, which has no `privileged` argument at the
Fargate launch type at all.)

Restated in the summary table: F1-F6 (§2 above, unchanged, re-verified)
plus G1-G4 below.

**G4 (INFORMATIONAL, designed, not enabled).** `read_only_root_filesystem`
is now an available, **opt-in, default-false** variable on
`modules/ecs-service` (with an automatic `/tmp` tmpfs mount when
enabled, sized for the worker's heartbeat file). Not force-enabled for
any service this phase: whether the `node:20-alpine`-based web
(Next.js standalone) and api images tolerate a read-only root
filesystem beyond `/tmp` has never been verified against a real running
container (Docker has been unavailable in every session to date, an
unchanged, long-standing limitation — same caveat as every Dockerfile
review since Phase 15). Enabling this for real should happen only after
that verification, per-service.

**G5 (INFORMATIONAL, not code-changed).** Manual re-alignment of
`terraform fmt`-style whitespace (several `=` alignment inconsistencies
pre-dating this phase, e.g. in `environments/*/main.tf`'s module
blocks) was deliberately **not** hand-edited this session — the real
`terraform fmt -check -recursive` in the new CI job (below) is the
correct tool to both detect and fix this, and hand-aligning HCL without a real
`terraform` binary to verify the result risks introducing exactly the
kind of unverified change this review otherwise avoids. Expect the
first CI run of the new `terraform-validate` job to fail on `fmt`
purely from this pre-existing whitespace drift, not from anything this
phase changed.

### CI Terraform validation (new this phase)

`.github/workflows/ci.yml` gained a `terraform-validate` job
(`hashicorp/setup-terraform`, pinned to Terraform 1.9.8): `terraform
fmt -check -recursive` once, then `terraform init -backend=false` +
`terraform validate` for each of `environments/{staging,production,shared}`.
**No AWS credential is configured anywhere in this job** —
`-backend=false` means `init` never attempts to reach the real
(nonexistent) S3/DynamoDB backend every `backend.tf` references, and no
`plan`/`apply` step exists. This is the first time any of this
Terraform source will actually be parsed by a real `terraform` binary
rather than reviewed by eye — expect it to surface real syntax/schema
issues neither Phase 26's nor this phase's manual review could catch
(per §0's own caveat, restated: eye review is not a substitute for the
real tool). Per §G5 above, the `fmt` step is expected to fail on its
first run from pre-existing whitespace drift — a real, human/CI
follow-up (not this phase, which cannot execute the tool) should run
`terraform fmt -recursive` for real and commit the result.

## 4. What this review does not do

- Does not run `terraform validate`/`plan`/`apply` locally — tool
  unavailable, and `apply`/`plan` against real credentials is
  explicitly forbidden regardless (CI now runs `fmt`/`validate` only —
  see above; that is a syntax/internal-consistency check, not a
  substitute for `plan` against a real account).
- Does not provision any AWS resource to test these findings against a
  real API response.
- Does not add a customer-managed KMS key, ALB access-log bucket, or
  any other F3/F4/F6 hardening — each remains documented as a decision
  for a human operator, not implemented speculatively.
- Does not create the `environments/shared` state's real S3/DynamoDB
  backend, or push any image to the `modules/ecr` repositories it
  defines.
