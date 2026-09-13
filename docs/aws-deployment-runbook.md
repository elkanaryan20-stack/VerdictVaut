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

**No ECR repository is created by this phase.**

## 4. Deployment pipeline — current state and future design

### 4.1 Current state (audited this session, unchanged)

`.github/workflows/ci.yml` — re-read in full this session:
`typecheck` → `lint` → `build` → `API unit tests` → `API integration
tests` → `Web unit tests` (all one job), plus two independent jobs
(`prisma-migration-validation`, `docker-build`). **No job pushes an
image anywhere, deploys anything, or holds any AWS credential.** This
is the intentional stopping point Phase 16 chose, restated by Phase 23
and still true today.

### 4.2 Future production pipeline (DESIGNED, NOT BUILT — requires the CI role in `docs/aws-iam-and-secrets.md` §2.5, which requires an AWS account)

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
is a hard requirement from this phase's brief, not an implementation
detail left to discretion. No workflow file implementing any pipeline
stage past "build/test" is added by this phase (there is no AWS
account/ECR/ECS cluster to deploy to yet — writing a workflow that
references real AWS resources now would either fail on every run or
require inventing resource identifiers, both explicitly forbidden).

### 4.3 What would need to exist before §4.2 can be built for real

1. An authorized AWS account (§`docs/aws-production-architecture.md` —
   human approval).
2. The 3 ECR repositories (§3) and the CI deploy IAM role
   (`docs/aws-iam-and-secrets.md` §2.5).
3. A real staging ECS cluster/services (§5 below) to deploy to
   automatically — the "staging" stage above has nothing to target
   today.
4. A decision on the manual-approval mechanism (GitHub Environments is
   the natural fit given this repo already uses GitHub Actions; not
   independently verified against GitHub's current documentation this
   session since it doesn't require inventing any AWS-specific claim).

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

## 6. What this document does not do

- Does not create an ECS cluster, service, task definition, ALB, ECR
  repository, or CI/CD workflow step that deploys anywhere.
- Does not push an image to any registry.
- Does not grant the CI role in §4.3 any real AWS credential.
- Does not weaken the manual-approval requirement for production
  deployment under any condition.
