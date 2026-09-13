# VerdictVaut Terraform — Phase 25 skeleton

**Status: DESIGNED, NOT APPLIED.** Every file under this directory is
a specification, reviewed for syntax by eye only. **`terraform` is not
installed in any development environment this repository has been
worked in to date (re-confirmed this session — `terraform -version`
returns "command not found"), so `terraform fmt`, `terraform validate`,
`terraform plan`, and `terraform apply` have never been run against
this code, not even once.** Treat this exactly like this repository's
own long-standing Docker-unavailability caveat on the Dockerfiles: a
real, human/CI environment with the tool installed must validate this
before it is trusted.

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
    observability/             CloudWatch log groups
  environments/
    staging/                   Wires the modules together for staging
    production/                Wires the modules together for production
                                — a SEPARATE state file from staging, always
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
