# AWS IAM & Secrets Management — Phase 25

**Status: DESIGNED, NOT PROVISIONED.** No IAM role, policy, or Secrets
Manager secret exists for this project. Every ARN-shaped string below
is illustrative (`arn:aws:...:<account-id>:...`) — no real AWS account
ID appears anywhere in this document.

Extends `docs/production-secret-management.md` (Phase 24 — the
provider-neutral secret inventory and the `env:` secret-ref scheme
already in this codebase) with AWS-concrete IAM roles and Secrets
Manager resource design. Does not re-derive the secret inventory —
that table remains authoritative; this document only adds the AWS
identity/access layer around it.

## 1. Guiding principle

**No application IAM role in this design uses `AdministratorAccess`,
`PowerUserAccess`, or any other AWS-managed broad policy.** Every role
below is scoped to exactly the API calls the component actually makes
— re-derived from what this codebase's AWS-facing needs actually are
(there are almost none in application code itself; re-verified this
session, same zero-SDK-dependency grep as Phase 23/24), not copied from
a generic "web app on AWS" template.

## 2. IAM roles

### 2.1 ECS task execution role (`verdictvaut-ecs-execution-role`)

Used by the ECS agent itself (not application code) to pull the
container image and inject secrets/logs — one shared execution role
across all three services is standard AWS practice and does not
weaken least-privilege, since this role never runs application code.

| Permission | Scope | Why |
|---|---|---|
| `ecr:GetAuthorizationToken`, `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage` | The 3 `verdictvaut-*` ECR repositories only (§`docs/aws-deployment-runbook.md` §3) | Pull the image at task start |
| `logs:CreateLogStream`, `logs:PutLogEvents` | The 3 `/ecs/verdictvaut-*` log groups only | Ship container stdout to CloudWatch |
| `secretsmanager:GetSecretValue` | Exactly the secret ARNs referenced by that task definition's `secrets` block (§3 below) — **not** a wildcard `secretsmanager:*` or `arn:...:secret:*` | This is what actually injects a secret as a container env var before the process starts; scoping it per-secret is the single most important least-privilege boundary in this document |

### 2.2 API task role (`verdictvaut-api-task-role`)

Assumed by the running API application process (distinct from the
execution role above).

| Permission | Scope | Why |
|---|---|---|
| None required by any AWS SDK call in application code today | — | Re-verified this session: zero `@aws-sdk/*` imports anywhere in `apps/api/src`. The API does not call any AWS API directly — it only *receives* env vars the execution role already injected. |

**This role can legitimately start with zero permissions beyond ECS's
own default trust policy.** If a future feature needs a direct AWS
call from application code (e.g. writing an object to S3), that
permission should be added narrowly at that time — not pre-granted
speculatively now.

### 2.3 Worker task role (`verdictvaut-worker-task-role`)

Same reasoning as §2.2 — zero `@aws-sdk/*` usage in the worker's code
path (`worker.main.ts` reuses `AppModule`, no separate AWS-facing code
exists). **Starts with zero permissions beyond the default trust
policy**, same as the API task role.

### 2.4 Web task role (`verdictvaut-web-task-role`)

Same reasoning — `apps/web` makes no AWS SDK calls (re-verified this
session, zero matches in `apps/web/lib`/`apps/web/app`, same grep as
Phase 23/24). **Zero permissions.**

### 2.5 CI/CD deploy role (`verdictvaut-ci-deploy-role`, assumed by GitHub Actions via OIDC federation — not an IAM user with long-lived access keys)

**Not created or used by this phase** — the existing `.github/workflows/ci.yml`
pushes nothing to AWS today (re-verified this session by reading the
full workflow — the `docker-build` job builds images locally on the
runner and never pushes anywhere). This role is specified here for
when a real production deployment pipeline is authorized
(§`docs/aws-deployment-runbook.md` §7):

| Permission | Scope | Why |
|---|---|---|
| `ecr:GetAuthorizationToken`, `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:BatchCheckLayerAvailability` | The 3 `verdictvaut-*` ECR repositories only | Push newly-built images |
| `ecs:UpdateService`, `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, `ecs:RegisterTaskDefinition` | The `verdictvaut` ECS cluster's 3 services only | Roll out a new task definition revision |
| `iam:PassRole` | Exactly the execution role + the specific task role being deployed — **never `iam:PassRole` on `*`** | ECS requires the deploying principal to be allowed to pass the task/execution roles to the new task definition; scoping this narrowly prevents the CI role from being used to launch a task with a *different*, more-privileged role |

**Authentication**: GitHub Actions OIDC federation (`aws-actions/configure-aws-credentials`
with `role-to-assume`, no static AWS access keys stored as a GitHub
secret) is the AWS-recommended pattern for exactly this use case —
noted as the intended mechanism, not configured or verified against
live GitHub/AWS OIDC trust-policy setup this session (would require a
real AWS account to actually register the identity provider).

## 3. Secrets Manager mapping

One secret per credential (not one giant JSON blob per environment) —
narrower IAM scoping per §2.1, and a compromised/rotated credential
never requires touching unrelated secrets.

| Secret name (example — not created) | Holds | Read by | Notes |
|---|---|---|---|
| `verdictvaut/production/database-url` | The fully-composed `DATABASE_URL` connection string | API execution role, worker execution role | Created by the `modules/database` Terraform module itself (`random_password` + a composed connection string) rather than RDS's native "Manage master credentials in Secrets Manager" feature — see `docs/aws-disaster-recovery.md` §1 and `infra/terraform/modules/database/main.tf`'s credential-design note for why the native feature's JSON-object shape doesn't fit this codebase's single-`DATABASE_URL`-string expectation without an application change this phase doesn't make |
| `verdictvaut/production/jwt-access-secret` | `JWT_ACCESS_SECRET` | API execution role only (JWT signing/verification happens in the API process; the worker never issues or verifies a JWT) | Generated once (`openssl rand -hex 32` or equivalent) outside Terraform/any IaC tool — never a literal value in committed code (§7) |
| `verdictvaut/production/jwt-refresh-secret` | `JWT_REFRESH_SECRET` | API execution role only | Same; must differ from the access secret (enforced today by `production-readiness-check.js`) |
| `verdictvaut/production/fireblocks-credentials` | Whatever `FIREBLOCKS_PRODUCTION_CREDENTIALS`-shaped value a real integration eventually needs (no such integration exists yet — §11 below) | API execution role, worker execution role | **Does not exist today** — production custody remains structurally blocked (`ProductionCustodyExecutor` throws); this row documents where it *would* live if that work is ever done, not a claim it exists |
| `verdictvaut/production/fireblocks-webhook-public-key` | `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` | API execution role only | Same "does not exist yet for production" caveat — the sandbox equivalent (`verdictvaut/sandbox/...`) is the only one with any real precedent in this codebase |
| `verdictvaut/production/elliptic-credentials` | Compliance provider credentials | API execution role only (compliance checks run in the API's synchronous withdrawal-request path — re-verified this session, `EllipticAddressRiskGate` is not called from `worker.main.ts`'s watcher services) | Same "does not exist yet" caveat as custody |
| `verdictvaut/production/postmark-server-token` | `POSTMARK_SERVER_TOKEN` | API execution role only | Real integration exists in code (`PostmarkEmailProvider`) but production is still blocked until a real production (non-sandbox) Postmark token + verified sending domain exist (§`docs/aws-production-architecture.md` §12) |
| `verdictvaut/sandbox/*` (mirrors every row above) | Same shape, sandbox-scoped values | Staging's own execution roles only — **never** the production execution roles | §6 below — the hard separation this phase's brief specifically requires |

**RPC credentials**: not listed as a distinct secret today because the
current configuration (`BITCOIN_TESTNET_RPC_URL` etc.) uses public,
uncredentialed testnet endpoints. If a production deployment adopts a
credentialed RPC provider (Infura/Alchemy/QuickNode), that URL becomes
secret-shaped (often embeds an API key) and should be added as
`verdictvaut/production/rpc-<network>` following the exact same
pattern — not designed further here since no such provider has been
chosen (would be inventing a provider capability, which this phase's
brief forbids).

## 4. ECS secret injection (not baked into images)

Every secret above is referenced in the ECS task definition's
`secrets` field (not `environment`), e.g. (illustrative, no real ARN):

```json
{
  "secrets": [
    {
      "name": "DATABASE_URL",
      "valueFrom": "arn:aws:secretsmanager:<region>:<account-id>:secret:verdictvaut/production/database-url"
    },
    {
      "name": "JWT_ACCESS_SECRET",
      "valueFrom": "arn:aws:secretsmanager:<region>:<account-id>:secret:verdictvaut/production/jwt-access-secret"
    }
  ]
}
```

The ECS agent resolves this **before the container process starts**,
setting a plain OS environment variable inside the task — which is
exactly what `env.validation.ts`/`ConfigService` and
`secret-ref.validator.ts`'s `env:` scheme already expect (unchanged
application code, re-verified this session; restated from
`docs/production-secret-management.md` §1, not re-derived differently
here). **No Docker image ever contains a secret value** — both
Dockerfiles were re-read this session and confirmed to `COPY`/`ENV`
nothing secret-shaped, only `NEXT_PUBLIC_*` build args on the web
image (which are non-secret by design, §5 below).

## 5. Web frontend never receives a server secret

Re-verified this session (same check as `docs/production-secret-management.md` §2):
only `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_APP_ENVIRONMENT` are ever
baked into the web build, both non-secret by Next.js's own
`NEXT_PUBLIC_*` convention. The web ECS task's own task definition, if
it needs any secret at all in the future, would still use the same
`secrets` mechanism as §4 — but today it needs none (`apps/web/.env.example`
re-read this session, contains only those two public variables).

## 6. Sandbox vs. production secret separation

- **Separate Secrets Manager path prefix** (`verdictvaut/sandbox/*` vs.
  `verdictvaut/production/*`) — never the same secret object reused
  across environments.
- **Separate IAM scoping** — the staging execution role's
  `secretsmanager:GetSecretValue` resource list only ever names
  `verdictvaut/sandbox/*` ARNs; the production execution role's only
  ever names `verdictvaut/production/*` ARNs. Neither role's policy
  grants access to the other prefix — this is an explicit IAM design
  requirement, not just a naming convention people are expected to
  follow.
- **Matches existing application-level separation**: `ComplianceGateFactory`/
  `WithdrawalExecutorFactory` already select sandbox vs. production
  behavior from `APP_ENVIRONMENT`, never from which secret happens to
  be injected (unchanged, Phase 14B) — the AWS-level separation above
  is a second, independent layer, not a substitute for that
  application-level gate.

## 7. Secrets never appear in CI logs or committed code

- **CI logs**: `.github/workflows/ci.yml`'s `docker-build` smoke test
  uses hardcoded, clearly-fake, non-secret placeholder strings (e.g.
  `"ci-smoke-test-access-secret-fake-not-real-000000"`) — re-verified
  this session by reading the full workflow. If a future deploy job
  needs a real secret, it must be referenced via `secrets.*` (GitHub's
  own encrypted-secret mechanism, redacted from logs automatically) or
  the OIDC role in §2.5 — never printed via `echo`/`run:` directly.
- **Application logs**: `JsonLoggerService`'s existing
  `redactSensitiveFields` pattern (matches `password`/`secret`/etc. in
  logged objects, unchanged, re-verified this session by reading the
  current file) already prevents a secret value from reaching stdout —
  and therefore CloudWatch Logs — today. This phase adds no new
  logging code and does not need to.
- **Committed code**: no Terraform/IaC file this phase adds contains a
  literal secret value (§`docs/aws-deployment-runbook.md`'s IaC
  section) — secret *values* are set out-of-band (AWS Console/CLI by a
  human, or a future secure CI step), never written into `.tf`/`.tfvars`.

## 8. What this document does not do

- Does not create an IAM role, policy, or Secrets Manager secret — no
  AWS account exists.
- Does not set a real secret value anywhere.
- Does not register a GitHub OIDC identity provider in any AWS
  account.
- Does not grant any role permissions beyond what this session could
  verify the corresponding application code actually needs by reading
  it directly (not by assuming a generic template's permission set).
