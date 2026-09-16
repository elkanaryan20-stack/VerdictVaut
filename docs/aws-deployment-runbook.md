# AWS Deployment Runbook — Phase 25

**Status: DESIGNED, NOT PROVISIONED.** Defines the 3 ECS services,
ALB/TLS configuration, ECR structure, and future CI/CD pipeline for
`docs/aws-production-architecture.md`'s target. No ECS cluster,
service, load balancer, or ECR repository exists for this project.
Cross-references `docs/production-deployment-plan.md` (Phase 24 —
provider-neutral health/rollback/staging-parity detail, not duplicated
here) and `docs/aws-network-design.md`/`docs/aws-iam-and-secrets.md`
for the network/IAM detail each already owns.

## 1. ECS services

| | `verdictvaut-web` | `verdictvaut-api` | `verdictvaut-worker` |
|---|---|---|---|
| Image | `apps/web/Dockerfile` | `apps/api/Dockerfile --target runtime` | `apps/api/Dockerfile --target worker` |
| Launch type | Fargate | Fargate | Fargate |
| Port | 3000 | 4000 | **none** |
| ALB target group | Yes | Yes (incl. `/webhooks/*`) | **No target group — not attached to the ALB at all** |
| Desired count (initial) | 2 | 2 | **1** (`docs/production-deployment-plan.md` §5's own reasoning — extra worker replicas mostly re-do the first one's read work at current scale; unchanged, not re-derived differently here) |
| CPU / memory (initial, unverified against real load) | 0.25–0.5 vCPU / 512MB–1GB | 0.5 vCPU / 1GB | 0.25–0.5 vCPU / 512MB — mostly network-bound, not compute-bound |
| Deployment strategy | ECS rolling update, `minimumHealthyPercent=100`, `maximumPercent=200` (never a capacity gap for a public-facing service) | Same | `minimumHealthyPercent=0`/`maximumPercent=200` acceptable at desired-count 1 (a brief processing gap during redeploy is safe — see the idempotency/lease design cited below; never a duplicate-processing risk) |
| Health check | ALB target-group health check: `GET /` → 200 | ALB target-group health check: `GET /health` → 200 (liveness); readiness is `GET /health/ready`, used by the deployment gate below, not the ALB target-group check itself | ECS container-level `HEALTHCHECK` only (heartbeat-file script, `scripts/worker-healthcheck.js`) — no ALB check exists since there's no target group |
| Restart behavior | ECS restarts a task whose container health check fails, per the service's own deployment configuration | Same | Same |
| Autoscaling | Target-tracking on ALB `RequestCountPerTarget` or CPU — not configured this phase (no load data exists to size a real policy against) | Same | **Not recommended** at current scale — `docs/production-deployment-plan.md` §5 already documents why more worker replicas don't parallelize useful work without a sharding redesign; autoscaling policy for the worker is explicitly not designed here |
| Environment variables | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_ENVIRONMENT` (build-time, baked into the image — not runtime task-definition env vars) | `PORT=4000`, `APP_ENVIRONMENT`, `CORS_ALLOWED_ORIGINS`, `CHAIN_WATCHER_ENABLED=false`, `WITHDRAWAL_WATCHER_ENABLED=false`, `EMAIL_PROVIDER`, `EMAIL_FROM_ADDRESS`, `EMAIL_BASE_URL` | Same DB/env baseline, plus `CHAIN_WATCHER_ENABLED=true`, `WITHDRAWAL_WATCHER_ENABLED=true`, `WORKER_HEARTBEAT_FILE`, `WORKER_HEARTBEAT_INTERVAL_MS` |
| Secret injection | None needed today (§`docs/aws-iam-and-secrets.md` §5) | `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `POSTMARK_SERVER_TOKEN`, Fireblocks/Elliptic credentials (sandbox-scoped today) — via task-definition `secrets` | `DATABASE_URL`, Fireblocks credentials (sandbox-scoped) |
| Logging | `awslogs` driver → `/ecs/verdictvaut-web` | `awslogs` driver → `/ecs/verdictvaut-api` | `awslogs` driver → `/ecs/verdictvaut-worker` |
| Graceful shutdown | Next.js standalone server's native `SIGTERM` handling | `app.enableShutdownHooks()` (`main.ts`, unchanged) | Explicit `SIGTERM`/`SIGINT` handlers (`worker.main.ts`, unchanged) — ECS's default 30s `stopTimeout` should be reviewed against real poll-cycle duration once measured; not measured this session |

**The worker remains a separate ECS service, never merged into the API
service or given a target group** — the one hard requirement this
phase's brief restates from every prior phase.

## 2. Load balancing / TLS

| Element | Design |
|---|---|
| ALB listeners | Two: `:443` (HTTPS, ACM certificate, forwards per rule below) and `:80` (HTTP, single rule: redirect to `:443` with the same host/path, `HTTP_301`) |
| HTTPS termination | At the ALB only — neither `apps/api` nor `apps/web`'s own HTTP server terminates TLS (unchanged application design, re-verified this session) |
| ACM certificate | DNS-validated against the chosen domain (§`docs/aws-production-architecture.md` §10 — domain/region not yet chosen) |
| API routing | Host-based rule (e.g. `api.<domain>` → API target group) **or** path-based rule (e.g. `/api/*`/`/webhooks/*` → API target group) — either is workable with this codebase's existing `NEXT_PUBLIC_API_URL`-driven client; the exact choice is a DNS/domain-structure decision requiring the real domain, not made here |
| Web routing | Default rule (any host/path not matched by the API rule) → web target group |
| Health endpoints used by the ALB | Web: `GET /`. API: `GET /health` (liveness only — the ALB target-group health check is not the same signal as `GET /health/ready`, which is deliberately reserved for deployment-gating and orchestrator-level DB-outage response, not target-group rotation, per `health.controller.ts`'s own docblock, unchanged) |
| Worker | **No listener rule, no target group, nothing routes to it — by design, not omission.** |

## 3. ECR

| Repository (example naming — not created) | Holds |
|---|---|
| `verdictvaut-web` | Web images |
| `verdictvaut-api` | API (`runtime` target) images |
| `verdictvaut-worker` | Worker (`worker` target) images |

- **Immutable tagging**: `imageTagMutability: IMMUTABLE` on all 3
  repositories — a tag, once pushed, can never be overwritten. This is
  what makes a rollback safe/predictable (§5 below) — redeploying "the
  previous tag" always means the exact same bytes, never a
  since-changed image quietly substituted underneath it.
- **Commit SHA tags**: every image tagged with the full git commit SHA
  it was built from (`verdictvaut-api:a1b2c3d...`), pushed by the
  future CI pipeline (§4) — never `latest` as the sole/primary tag for
  a production deployment (a `latest`-only strategy makes "what's
  actually running" unanswerable and rollback undefined).
- **Rollback tags**: an ECS service rollback is "redeploy the task
  definition revision that pointed at the previous commit SHA's
  image" — no separate `rollback`-labeled tag scheme is needed given
  immutable SHA tagging already makes every prior image individually
  addressable.
- **Retention policy**: an ECR lifecycle policy expiring untagged
  images after a short window (e.g. 7 days — cleans up failed/aborted
  build artifacts) and keeping the most recent N tagged images (e.g.
  50) indefinitely — exact numbers are an operational-cost tradeoff for
  whoever provisions this, not fixed here.
- **Vulnerability scanning**: ECR's built-in "scan on push" (Basic,
  free tier) enabled on all 3 repositories at minimum; Enhanced
  scanning (continuous, Inspector-backed) is a stronger option with
  its own cost — noted as available, not selected, since this is a
  cost/tooling decision outside this repository's authority.

**No ECR repository is created by this phase** — Phase 27 added the
Terraform module that defines this exact configuration
(`infra/terraform/modules/ecr`, wired from a new, separate
`environments/shared` root module/state — see that module's header
note for why the registry must be a single shared resource rather than
duplicated per environment, given §4's build-once/promote pipeline),
but that module has still never been applied against a real AWS
account.

## 4. Deployment pipeline — current state and future design

### 4.1 Current state (Phase 28 update)

`.github/workflows/ci.yml`, unchanged this phase: `typecheck` → `lint`
→ `build` → `API unit tests` → `API integration tests` → `Web unit
tests` (all one job), plus `prisma-migration-validation`,
`docker-build`, and `terraform-validate` (Phase 27). **Still holds no
AWS credential and still never pushes an image or deploys anything.**

**New this phase**: `.github/workflows/terraform-deploy.yml` (real
`terraform plan`, and `terraform apply` gated behind a GitHub
Environment approval) and `.github/workflows/ecr-publish.yml` (build +
push immutable commit-SHA-tagged images, then update the 3 ECS
services via a new task-definition revision, gated behind a GitHub
Environment approval for production). **Both are `workflow_dispatch`
only — never triggered by a push to `main`** — and both will fail
immediately at their AWS-credentials step today: the `AWS_TERRAFORM_ROLE_ARN`
and `AWS_CI_DEPLOY_ROLE_ARN` GitHub secrets they reference are not set
anywhere, and no AWS account exists regardless. This is the intended,
honest state — see §4.3 below for exactly what must exist first.

### 4.2 Production pipeline design (workflows exist in code — §4.1 — usable only once §4.3 is satisfied)

```
commit
  ↓
tests (existing: API unit + integration, web unit — unchanged)
  ↓
typecheck / lint (existing, unchanged)
  ↓
build (existing, unchanged)
  ↓
Docker image build (existing docker-build job, extended to push)
  ↓
security validation (container image vulnerability scan result gate —
                      ECR scan-on-push or a dedicated scanning step;
                      not implemented today, no scanner currently runs
                      in CI)
  ↓
migration validation (existing prisma-migration-validation job,
                       unchanged — schema-syntax hard gate + informational
                       diff report)
  ↓
image registry (push to ECR, tagged with the commit SHA — §3)
  ↓
staging (automatic deploy to the staging ECS services — §`docs/aws-production-architecture.md`'s
          staging/production separation, §5 below)
  ↓
MANUAL PRODUCTION APPROVAL — a human-gated step (GitHub Environments'
          "required reviewers" feature, or an equivalent manual gate)
  ↓
production deployment (ECS service update — only after the manual gate
          above is explicitly approved by a human)
```

**Production deployment is never automatic** — the manual-approval gate
is a hard requirement, implemented as a GitHub Environment reference
(`environment: ${{ inputs.environment }}-deploy` in `ecr-publish.yml`,
`${{ inputs.environment }}-infra-apply` in `terraform-deploy.yml`) that
a human must separately configure with required reviewers in GitHub's
own Settings UI — this repository's workflow files reference that gate
by name but cannot create the protection rule itself (not a GitHub API
this phase has credentials for, and not something Terraform manages).
**Phase 28 update**: both workflows now exist in code (§4.1) — every
AWS-resource reference inside them is a GitHub secret/variable, never
an invented identifier, so running either today fails clearly at the
credentials step rather than silently or against a fabricated target.

### 4.3 What must exist before §4.2 can actually run for real

1. An authorized AWS account (§`docs/aws-production-architecture.md` —
   human approval).
2. The full provisioning sequence in `docs/aws-production-change-control.md`
   §4, run once for real — steps 1-9 at minimum, so the 3 ECR
   repositories, the CI deploy role (`docs/aws-iam-and-secrets.md`
   §2.5, `infra/terraform/modules/ci-deploy-role`), and both ECS
   clusters/services actually exist.
3. `AWS_TERRAFORM_ROLE_ARN` and `AWS_CI_DEPLOY_ROLE_ARN` set as real
   GitHub Actions secrets, and `AWS_REGION`/`NEXT_PUBLIC_API_URL` set
   as GitHub Actions variables — `.github/workflows/terraform-deploy.yml`/`ecr-publish.yml`
   read these by name and fail clearly (not silently, not against a
   fabricated value) until they exist.
4. Two GitHub Environments actually configured with required reviewers
   in Settings (e.g. `production-infra-apply`, `production-deploy`) —
   the workflow files reference these names but cannot create the
   protection rule itself.

## 5. Staging vs. production (AWS-level)

Per this phase's brief, staging must be genuinely separate, never
pointing at production custody/compliance/email:

| | Staging | Production |
|---|---|---|
| `APP_ENVIRONMENT` | `sandbox` — **explicit, never inferred** | `production` |
| Custody provider | `ManualBroadcastExecutor`/real Fireblocks **sandbox** adapter (`FireblocksCustodyAdapter` against `sandbox-api.fireblocks.io`, unchanged existing code) | `ProductionCustodyExecutor` — unconditionally throws until real production custody is built (out of scope, unchanged) |
| Compliance provider | `DeferredComplianceGate` default, or real Elliptic **sandbox** adapter if credentials configured | `ComplianceGateFactory` forces `DeferredComplianceGate` regardless of configuration (`ProductionSafetyGate` independently re-checks this at boot, §`docs/aws-production-architecture.md` §11) |
| Email | `NoopEmailProvider` or Postmark **sandbox/test** token | Blocked until a real production Postmark token + verified domain exist (§`docs/aws-production-architecture.md` §12) |
| Database | A separate RDS instance (or, minimally, a separate database within a non-production-tier instance — a genuinely separate *instance* is preferred so a staging mistake can never touch production capacity/backups) | Its own RDS instance, Multi-AZ, deletion-protected (`docs/aws-disaster-recovery.md`) |
| Secrets | `verdictvaut/sandbox/*` path prefix, separate IAM scoping (`docs/aws-iam-and-secrets.md` §6) | `verdictvaut/production/*`, disjoint IAM scoping |
| ECS services | A separate, smaller set of `verdictvaut-*-staging` services (or a separate ECS cluster entirely — either satisfies "isolated," cluster-per-environment is slightly stronger isolation and the recommended default here) | The services in §1 |
| Network | A separate VPC (recommended — matches the "isolated database" requirement most cleanly) or a separate subnet set within a shared non-production VPC — **never the same VPC as production's database subnets** | The VPC in `docs/aws-network-design.md` |

**Never allow a staging task definition's secrets/environment
variables to reference a `verdictvaut/production/*` secret ARN or a
production `APP_ENVIRONMENT` value** — this is an IAM-and-configuration
discipline requirement, not enforced by any new code this phase adds
(the existing `ProductionSafetyGate`/`WithdrawalExecutorFactory`/
`ComplianceGateFactory` application-level gates remain the actual
enforcement mechanism regardless of which AWS environment a container
happens to run in).

## 6. What this document (and Phase 28's workflows) does not do

- Does not create a real ECS cluster, service, task definition, ALB, or
  ECR repository — Terraform defines them; `apply` has never been run.
- Does not push an image to any registry — `ecr-publish.yml` exists in
  code but has never executed against a real AWS account.
- Does not grant the CI role in §4.3 any real AWS credential, and does
  not create the GitHub Environment protection rules its workflows
  reference by name.
- Does not weaken the manual-approval requirement for production
  deployment under any condition.
- Does not auto-trigger either new workflow on push/merge — both are
  `workflow_dispatch` only.
