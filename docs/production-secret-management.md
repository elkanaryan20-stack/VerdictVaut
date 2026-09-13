# Production Secret Management — Phase 24

Maps every production secret/configuration value this repository
actually expects (per `apps/api/.env.example`, `apps/web/.env.example`,
and `src/config/env.validation.ts` — re-read this session, not assumed)
to where it should live in production. No real secret value is placed
in this file or any other repository file — every value below is a
variable name and a description.

Recommended target: AWS Secrets Manager, per
`docs/production-infrastructure-decision.md`'s Phase 24 recommendation
(not yet authorized/provisioned). The mapping principle is provider-
neutral — any managed secret store with the same properties (encrypted
at rest, access-controlled, audit-logged, injectable as a container
env var at start) would satisfy the same requirements.

## 1. How secrets already flow in this codebase (unchanged, re-verified this session)

Two distinct patterns already exist and are **not** changed by this
phase:

1. **Plain environment variables**, read directly by
   `env.validation.ts`/`ConfigService` at boot (`DATABASE_URL`,
   `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `POSTMARK_SERVER_TOKEN`,
   etc.) — these must be injected into the container's OS environment
   before the Node process starts. In production, "injected" means the
   container orchestrator resolves them from a secret store and sets
   them as env vars — the application code makes no distinction and
   needs none.
2. **`"scheme:path"` secret references**, stored as plain (non-secret)
   strings in the database (`CustodyProviderConfig.credentialsSecretRef`,
   `ComplianceProviderConfig.credentialsSecretRef`,
   `CustodyProviderConfig.webhookSecretRef` — Phase 14A/14B), resolved
   at runtime by `secret-ref.validator.ts`/`SecretResolverService`.
   **Only the `env:` scheme resolves today** — `env:FIREBLOCKS_SANDBOX_CREDENTIALS`
   reads that env var. This means pattern 2 reduces to pattern 1 in
   practice: whatever secret store injects env vars for pattern 1 also
   satisfies pattern 2, with **zero application code changes required**
   to go to production, as long as the referenced env var is actually
   set by the deployment platform.

This is why AWS ECS's native "secrets" task-definition field (which
resolves a Secrets Manager ARN into a plain container env var before
the process starts) fits this repository's existing design exactly —
noted in `docs/production-infrastructure-decision.md`'s Phase 24
recommendation, not duplicated in full here.

## 2. Full secret/configuration inventory

| Variable | Used by | Production source | Runtime-only? | Frontend-exposed? |
|---|---|---|---|---|
| `DATABASE_URL` | API, worker | Secret manager — ideally auto-generated alongside the RDS instance and rotated via managed rotation | Yes — read once at `PrismaService.onModuleInit()` | **Never** |
| `JWT_ACCESS_SECRET` | API | Secret manager, generated once (`openssl rand -hex 32` or equivalent), manually rotated (forces re-login for active sessions — `docs/operations-runbook.md` §10) | Yes | **Never** |
| `JWT_REFRESH_SECRET` | API | Same as above — **must be a different value from `JWT_ACCESS_SECRET`** (enforced by `production-readiness-check.js`) | Yes | **Never** |
| `POSTMARK_SERVER_TOKEN` | API (`PostmarkEmailProvider`) | Secret manager | Yes | **Never** |
| `EMAIL_FROM_ADDRESS` | API | Plain config (not secret — a verified sender address), can be a regular env var/parameter, not secret-manager-gated | Yes | Never (server-side only, appears in outbound email headers, not in any API response) |
| `EMAIL_BASE_URL` | API | Plain config — the public web app origin used to build verification links | Yes | Never directly returned to the frontend as config, though it shapes email link URLs a user does see |
| `FIREBLOCKS_SANDBOX_CREDENTIALS` (and any future `FIREBLOCKS_PRODUCTION_CREDENTIALS`-shaped var, not yet created — production custody remains structurally blocked, see below) | API, worker (`FireblocksCustodyAdapter`) | Secret manager — referenced indirectly via `CustodyProviderConfig.credentialsSecretRef = "env:FIREBLOCKS_..."` | Yes | **Never** |
| `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` | API (`fireblocks-webhook.controller.ts`, RSA-SHA512 signature verification) | Secret manager (it's a public key, but treated with the same rigor since a wrong/stale value breaks webhook verification silently) | Yes | **Never** |
| `ELLIPTIC_SANDBOX_CREDENTIALS` | API (`EllipticAddressRiskGate`, HMAC-SHA256 signing) | Secret manager, referenced via `ComplianceProviderConfig.credentialsSecretRef` | Yes | **Never** |
| `BITCOIN_TESTNET_RPC_URL`, `ETHEREUM_SEPOLIA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `SOLANA_DEVNET_RPC_URL`, `XRPL_TESTNET_RPC_URL` (and their eventual mainnet equivalents, not yet created) | Worker (primarily), API (on-demand reconciliation paths) | Plain config today (public testnet endpoints, no credential embedded) — **if** a credentialed provider (Infura/Alchemy/QuickNode) is used for production mainnet RPC, the URL itself becomes secret-shaped (often embeds an API key in the path/query) and must move to the secret manager at that point | Yes | **Never** |
| `CORS_ALLOWED_ORIGINS` | API | Plain config (not secret) — must be explicitly set in production (empty fails closed but breaks all browser clients) | Yes (read at boot) | N/A — it configures what origins may call the API, not something returned to a frontend |
| `ENABLE_DEV_FUNDING_TOOLS` | API | Plain config — must be `false`/unset in production, enforced by `production-readiness-check.js` | Yes | **Never** |
| `CHAIN_WATCHER_ENABLED`, `WITHDRAWAL_WATCHER_ENABLED`, `ALLOW_WATCHERS_IN_API_PROCESS` | API, worker | Plain config — topology flags (`false`/`false` on the API deployment unit, `true`/`true`/N/A on the worker unit) | Yes | N/A |
| `WORKER_HEARTBEAT_FILE`, `WORKER_HEARTBEAT_INTERVAL_MS` | Worker | Plain config | Yes | N/A |
| `EMAIL_PROVIDER` | API | Plain config (`postmark` in production — `none`/`NoopEmailProvider` is refused at boot by `assertProductionEmailConfigured`) | Yes | N/A |
| `NEXT_PUBLIC_API_URL` | Web | **Build-time**, baked into the static/standalone output — Next.js's own `NEXT_PUBLIC_*` convention | Build-time, not runtime | **Yes, by design** — this is the API's public URL, not a secret |
| `NEXT_PUBLIC_APP_ENVIRONMENT` | Web | Build-time | Build-time | **Yes, by design** — a non-secret environment label |

**No `NEXT_PUBLIC_*` variable in this repository is secret-shaped** —
re-verified this session by reading `apps/web/next.config.mjs` and
`apps/web/.env.example` in full; only a public API URL and an
environment label are ever embedded into the web build. This is the
one hard boundary this document exists to protect: **nothing in the
table above other than the `NEXT_PUBLIC_*` rows may ever be prefixed
`NEXT_PUBLIC_` or otherwise bundled into client-side JavaScript** —
Next.js's own convention already makes this an opt-in, not
accidental, but it's worth stating as an explicit rule for whoever
adds a new env var in the future.

## 3. Production custody/compliance credentials — structurally blocked, not just unconfigured

`FIREBLOCKS_SANDBOX_CREDENTIALS`/`ELLIPTIC_SANDBOX_CREDENTIALS` above
are named `_SANDBOX_` deliberately — **no production-named equivalent
exists in this repository today**, because `ProductionCustodyExecutor`
unconditionally throws and `ComplianceGateFactory` unconditionally
forces `DeferredComplianceGate` whenever `APP_ENVIRONMENT=production`,
regardless of any secret being configured (`docs/provider-integration.md`,
unchanged, re-verified this session). Provisioning a secret manager and
choosing a cloud provider does **not**, by itself, change this — a real
production custody/compliance integration is a separate, unstarted
piece of work, entirely out of this phase's scope, exactly as it was
out of scope for Phases 14B through 23.

## 4. Rotation

| Secret class | Rotation mechanism | Operational impact |
|---|---|---|
| `DATABASE_URL` credential | AWS Secrets Manager's managed/Lambda-based rotation for RDS (if AWS is authorized) — re-verified this session that Secrets Manager documents managed and Lambda-based rotation paths, `docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_how.html` | Requires the application to re-read `DATABASE_URL` — Prisma's pool is created once at boot, so a rotated credential requires a coordinated redeploy/restart, same limitation already documented for JWT secrets (`docs/operations-runbook.md` §10) |
| `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` | Manual — generate a new value, redeploy | Forces re-login for every active session (unchanged, `docs/operations-runbook.md` §10) |
| Provider credentials (Fireblocks/Elliptic/Postmark) | Manual — rotate on the provider's dashboard, update the secret manager value, redeploy | No live-reload path exists in this codebase for any env-var-sourced secret — this is a known, accepted limitation, not new to this phase |

**Rotating any secret in this table always requires a coordinated
redeploy** — restated from the Phase 23 decision document, unchanged;
no secret is read more than once per process lifetime anywhere in this
codebase (re-verified this session by reading `env.validation.ts`,
`PrismaService`, and every provider adapter's constructor).

## 5. What this document does not do

- Does not create a real AWS Secrets Manager secret, IAM policy, or
  rotation Lambda — no cloud account exists.
- Does not add a new `secret-ref.validator.ts` scheme (e.g. `awssm:`)
  — unnecessary, since ECS's own secret injection already produces a
  plain env var the existing `env:` scheme already handles (§1 above).
  If a future provider's container platform does **not** support
  env-var injection from its secret store (uncommon), a new scheme
  would need to be added then — not invented speculatively now.
- Does not place any real secret value anywhere in this repository —
  re-verified this session: `apps/api/.env.example` and
  `apps/web/.env.example` contain only placeholder strings
  (`changeme-access-secret-min-32-chars`,
  `<set-in-secret-manager-or-local-env>`, etc.), never a real value.
