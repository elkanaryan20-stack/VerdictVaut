# Production Infrastructure Decision — Phase 23

This document turns VerdictVaut's existing deployment architecture
(Phase 15/16 Dockerfiles + CI, Phase 22 backup/DR) into a concrete
production infrastructure contract: a provider comparison, a
recommended (not provisioned) target architecture, and the network/
secret/deployment/observability models a real production rollout needs.

**No cloud provider has been selected anywhere in this repository's
history.** `docs/production-database-requirements.md` §5 and
`docs/database-backup-recovery.md` §7 already stated this; re-verified
directly against the current file contents this phase, not assumed.
Every claim below is labeled one of:

- **IMPLEMENTED** — real, in this repository, verifiable by reading the
  cited file.
- **REQUIRES PROVISIONING** — a real capability that needs an actual
  cloud account/resource to exist; described here as a requirement, not
  claimed as done.
- **NOT VERIFIED** — code/tooling exists but has not been exercised
  against the real thing it would need (a live provider, Docker).
- **BLOCKED** — deliberately, structurally prevented from happening
  until a real prerequisite exists (e.g. production custody).

## 1. Current architecture — audited this session

```
                    ┌─────────────────────────────────────┐
                    │         Next.js web (standalone)      │
                    │   apps/web/Dockerfile → verdictvaut-web│
                    │   node apps/web/server.js, port 3000   │
                    └───────────────┬───────────────────────┘
                                    │ HTTPS (NEXT_PUBLIC_API_URL)
                                    ▼
                    ┌─────────────────────────────────────┐
                    │            NestJS API                 │
                    │  apps/api/Dockerfile --target runtime  │
                    │  node apps/api/dist/main.js, port 4000 │
                    │  NO blockchain watchers (guarded —     │
                    │  watcher-boundary.guard.ts)             │
                    └───────────────┬───────────────────────┘
                                    │ DATABASE_URL
                                    ▼
                    ┌─────────────────────────────────────┐
                    │       PostgreSQL 16 (Prisma)           │
                    │  local: infra/docker-compose.yml       │
                    │  production: NOT CHOSEN (§2)           │
                    └───────────────▲───────────────────────┘
                                    │ DATABASE_URL
                    ┌───────────────┴───────────────────────┐
                    │      Background worker (Phase 16)      │
                    │  apps/api/Dockerfile --target worker   │
                    │  node apps/api/dist/worker.main.js     │
                    │  no HTTP port; heartbeat-file liveness │
                    │  DepositWatcherService/                │
                    │  WithdrawalWatcherService only         │
                    └───────────────┬───────────────────────┘
                                    │ outbound only
                                    ▼
                    blockchain RPC · Fireblocks · Elliptic · Postmark
```

Re-verified this session, not assumed from a prior report:

| Component | File | Status |
|---|---|---|
| API Dockerfile (`runtime`/`worker` targets) | `apps/api/Dockerfile` | IMPLEMENTED — multi-stage, `USER node` (non-root) on both targets, `npm prune --omit=dev`, no secrets baked in, `HEALTHCHECK` on both, migrations deliberately never run at container start |
| Web Dockerfile | `apps/web/Dockerfile` | IMPLEMENTED — standalone Next.js output, non-root, `HEALTHCHECK`, only `NEXT_PUBLIC_*` build args ever embedded |
| Worker entrypoint | `apps/api/src/worker.main.ts` | IMPLEMENTED — reuses `AppModule` (no hand-duplicated provider graph), real `SIGTERM`/`SIGINT` handlers calling `app.close()` (runs every watcher's graceful-shutdown `OnModuleDestroy`), heartbeat file write-failure never crashes the process |
| Watcher boundary | `src/config/watcher-boundary.guard.ts` | IMPLEMENTED — API process refuses to boot if a watcher flag is on without explicit `ALLOW_WATCHERS_IN_API_PROCESS=true` opt-in |
| Env validation | `src/config/env.validation.ts` | IMPLEMENTED — `APP_ENVIRONMENT=production` unconditionally refused today (custody/compliance/email blockers — Phases 13/20) |
| Production readiness gate | `apps/api/scripts/production-readiness-check.js` | IMPLEMENTED — 22 checks as of this phase (was 21 after Phase 22), correctly BLOCKED |
| CI | `.github/workflows/ci.yml` | IMPLEMENTED — typecheck/lint/build (all 3 workspaces incl. worker via `nest build`)/unit/integration tests, Prisma schema validation + migration-diff report, Docker build of all 3 targets **plus a real boot-and-`/health`/`/health/ready` smoke test** of the API image against a throwaway Postgres service container |
| Backup/DR | `infra/backup.sh`/`restore.sh`, `apps/api/scripts/backup-restore-drill.js` | IMPLEMENTED (Phase 22, not duplicated here) — real drill passed 22/22 checks; see `docs/production-database-readiness.md` |
| Observability | `src/observability/` | IMPLEMENTED (structured logs, provider-neutral `MetricsService`) — no external sink connected |

## 2. Cloud provider decision matrix

**No provider is selected by this document.** This is a comparison for
whoever owns that decision — presented so the choice can be made with
current, verified information, not a recommendation this repository
enforces.

| Capability | AWS | Google Cloud | Azure |
|---|---|---|---|
| Managed PostgreSQL | RDS for PostgreSQL (or Aurora PostgreSQL-Compatible) | Cloud SQL for PostgreSQL | Azure Database for PostgreSQL — Flexible Server |
| PITR — **verified against current official docs, fetched this session** | Continuous: transaction logs uploaded to S3 every 5 minutes; restore to any point within the retention window; **always creates a new instance**, never overwrites the source (`docs.aws.amazon.com/AmazonRDS/.../USER_PIT.html`) | Continuous transaction-log-based; recovery window bounded by earliest/latest recoverable timestamps; **"a point-in-time recovery always creates a new instance; you cannot perform a PITR to an existing instance"** (`docs.cloud.google.com/sql/docs/postgres/backup-recovery/pitr`) | Snapshot + continuous WAL archiving; default 7-day retention, configurable up to 35 days; **stated RPO "can be up to five minutes"**; always restores to a **new** server, never overwrites the source; optional geo-redundant backup (separate region) with up to ~1 hour additional RPO for the geo-copy specifically (`learn.microsoft.com/.../concepts-backup-restore`) |
| Automated backups | Yes, daily snapshot + continuous log shipping | Yes, automated + on-demand | Yes, daily snapshot (first full, then differential) + continuous WAL |
| Multi-AZ / HA | RDS Multi-AZ (synchronous standby, automated failover) | Cloud SQL "regional" (HA) configuration | Zone-redundant HA (synchronous standby) |
| Container hosting fit for this repo's existing Dockerfiles | ECS Fargate (serverless containers) or App Runner | Cloud Run (serverless containers) or GKE | Azure Container Apps or AKS |
| Private networking | VPC + security groups | VPC + firewall rules | VNet + NSGs |
| Secret management | AWS Secrets Manager (native RDS credential-rotation integration exists) | Google Secret Manager | Azure Key Vault |
| Load balancing / TLS | ALB + ACM | Cloud Load Balancing + Google-managed certs | Application Gateway / Front Door + App Service Managed Certificates |
| Logging | CloudWatch Logs | Cloud Logging | Azure Monitor Logs |
| Monitoring/alerting | CloudWatch Alarms | Cloud Monitoring | Azure Monitor Alerts |
| Fit with this repo's existing Docker+CI (no code changes implied) | Good — plain Docker images, no AWS-specific API used anywhere in application code | Good — same | Good — same |
| Operational complexity for an MVP (subjective, not a verified provider claim) | Moderate — ECS/Fargate + RDS is a well-trodden, well-documented path | Moderate-low — Cloud Run's per-request billing and simpler IAM model is often the least operational overhead for a small team | Moderate — comparable to AWS |
| Cost/complexity for an MVP (subjective — no pricing verified this session, changes over time; get a current quote before deciding) | Not verified this session | Not verified this session | Not verified this session |

**Column legend**: PITR row = **verified provider capability** (fetched
from each provider's own current documentation this session, quoted
where load-bearing). All other rows are either a stable, well-known
product-existence fact (e.g. "AWS has a service called Secrets
Manager") or an explicitly-labeled subjective assessment — never
presented as a verified guarantee.

**This document does not recommend one over the other as a final
choice** — that is a business decision (existing team cloud experience,
existing vendor relationships, compliance/data-residency requirements
none of which this repository has visibility into). Where a
architecture needs to be described concretely for §3 below, it is
described in provider-neutral terms; a `<CHOSEN PROVIDER>` placeholder
marks anywhere a real decision would fill in a specific product name.

## 3. Recommended target architecture — **RECOMMENDED, NOT YET PROVISIONED**

```
                              Internet
                                 │
                                 ▼
                    ┌───────────────────────────┐
                    │   TLS termination / LB     │   <CHOSEN PROVIDER's
                    │  (ALB / Cloud LB / App GW)  │   managed load balancer>
                    └─────────────┬─────────────┘
                                  │ HTTPS only
                    ┌─────────────┴─────────────┐
                    │                             │
                    ▼                             ▼
          ┌──────────────────┐         ┌──────────────────┐
          │   Web service      │        │    API service     │
          │ (Next.js standalone)│        │  (NestJS runtime)   │
          │  public subnet /    │        │  public subnet /    │
          │  public ingress     │        │  public ingress     │
          └──────────────────┘         └─────────┬────────┘
                                                    │ DATABASE_URL (TLS)
                                                    ▼
                                    ┌───────────────────────────┐
                                    │      PRIVATE subnet         │
                                    │  Managed PostgreSQL primary │
                                    │  <CHOSEN PROVIDER>          │
                                    └─────────────┬─────────────┘
                                                    │
                                    ┌─────────────┴─────────────┐
                                    │  Automated backups + WAL/   │
                                    │  PITR (provider-native)     │
                                    └─────────────┬─────────────┘
                                                    │
                                    ┌─────────────┴─────────────┐
                                    │  Standby/replica (HA) —     │
                                    │  same-region synchronous,   │
                                    │  where the provider's HA    │
                                    │  tier is enabled            │
                                    └───────────────────────────┘

  Independently:

          ┌──────────────────┐
          │  Worker service     │   private subnet, NO public ingress,
          │ (background watcher)│   no HTTP port at all (matches
          │  no HTTP surface    │   worker.main.ts's own design)
          └─────────┬──────────┘
                    │ DATABASE_URL (TLS, private)
                    ▼
          [ same managed PostgreSQL primary above ]
                    │
                    │ outbound only, egress-filtered
                    ▼
     blockchain RPC providers · Fireblocks · Elliptic · Postmark
```

**The API and worker remain independently deployable units — exactly
as Phase 16 built them.** Nothing in this architecture runs blockchain
watchers inside the API process; `watcher-boundary.guard.ts` continues
to enforce that at the code level regardless of how deployment is
configured.

## 4. Networking

| Concern | Model |
|---|---|
| Public vs private | Web + API: public ingress (behind TLS/LB). Worker: **no public ingress at all** — it binds no port (`worker.main.ts`'s own design, unchanged). Database: **private only, never publicly reachable.** |
| Database private access | The managed PostgreSQL instance must live in a private subnet/VPC with no public endpoint; API and worker reach it over the private network only. |
| Inbound ports | Web: 443 (TLS) from the internet, forwarded to the container's port 3000 by the LB. API: 443 (TLS) from the internet (and from the web service, and from any provider webhook — see below), forwarded to port 4000. Worker: **no inbound port of any kind.** Database: 5432, reachable only from the API/worker's private subnet/security-group, never from `0.0.0.0/0`. |
| Outbound (egress) requirements | Worker: blockchain RPC endpoints (per `rpc-config.service.ts`'s configured URLs), custody provider (Fireblocks sandbox/production API), compliance provider (Elliptic). API: same custody/compliance providers (for synchronous calls, e.g. compliance screening at withdrawal-request time) + Postmark (email). Both: the database, and whatever secret-manager endpoint the chosen provider uses. |
| TLS termination | At the load balancer/gateway, not the application containers — `apps/api`'s own HTTP server does not terminate TLS itself. `DATABASE_URL` must independently enforce TLS to the database (`sslmode=require`/`verify-ca`/`verify-full` — already enforced fail-closed by `database-tls.validator.ts` whenever `APP_ENVIRONMENT=production`). |
| Security groups / firewall rules | Database security group: inbound 5432 from the API/worker security group only. API/web security groups: inbound 443 from the LB only. Worker security group: **no inbound rule needed at all.** **Never an "allow all" (`0.0.0.0/0`) rule on anything but the public-facing LB's own 443 listener.** |
| Provider webhook ingress | `POST /webhooks/fireblocks` is deliberately outside `JwtAuthGuard` (Phase 14B) — reachable from the internet by design, but signature-verified (RSA-SHA512, `Fireblocks-Signature` header) before any JSON parsing. This is an API-process route; the LB must route it through like any other public API path, not expose it separately. |
| Blockchain RPC egress | Worker-only in the two-process deployment model (API never opens a chain RPC connection except via the same reprocessing/reconciliation code paths, which are on-demand, not a poll loop) — egress rules should scope this to the worker's security group. |
| Email-provider egress | API only (`PostmarkEmailProvider`, synchronous call from `AuthService`). |
| Custody-provider egress | Both API (withdrawal request/approval flow) and worker (poll-based confirmation checking, `WithdrawalWatcherService`). |

**No IP address is hardcoded anywhere in this document or the
application** — every endpoint above is reached via DNS/configured
`DATABASE_URL`/RPC URL, matching the existing `rpc-config.service.ts`
pattern of configurable endpoints with public-testnet defaults.

## 5. Secrets

| Secret | Production requirement |
|---|---|
| `DATABASE_URL` | From the chosen provider's connection-string mechanism (often itself referencing a secret-manager-stored password) — never committed, never logged (already true — `redactSensitiveFields` pattern matches `password`/`secret`/etc. in structured log objects; `DATABASE_URL` as a bare positional value is not logged anywhere in current code, verified by grep this session). |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Generated once (`openssl rand -hex 32` or equivalent), stored in the chosen secret manager, injected as an env var at container start. Rotation forces re-login for every active session (`docs/operations-runbook.md` §10, unchanged) — plan a maintenance window, not a silent mid-peak rotation. |
| Fireblocks credentials | Already never stored as a raw value in this codebase — `CustodyProviderConfig.credentialsSecretRef` holds a `"scheme:path"` reference (`secret-ref.validator.ts`); only the `env:` scheme resolves today. In production, the referenced env var's actual value must come from the chosen secret manager, injected at container start — the database row itself never changes when the secret value rotates, only when the reference path does. |
| Compliance-provider (Elliptic) credentials | Same `credentialsSecretRef` pattern as Fireblocks. |
| Postmark credentials | `POSTMARK_SERVER_TOKEN` (Phase 20) — same requirement: production value comes from the secret manager, never committed (`.env.example` only ever holds a placeholder — verified unchanged this session). |
| Webhook secrets | `CustodyProviderConfig.webhookSecretRef` (Fireblocks) — same reference pattern. |
| RPC credentials | Optional today (public testnet RPC endpoints are the default — `rpc-config.service.ts`); a credentialed provider (Infura/Alchemy/QuickNode) for production would be a plain env var, same secret-manager-at-runtime requirement. |
| Any future infrastructure secret | Follow the same established pattern: a `"scheme:path"` reference in application config/DB, resolved at runtime only, never a raw value in a committed file. |

**Secret rotation expectation**: rotating any of the above requires a
coordinated redeploy (env vars are read at process start, no live
reload) — restated from `docs/operations-runbook.md` §10, unchanged.

**Verified this session — no repository file contains a secret**:

```
grep -rniE "aws-sdk|@aws-sdk|@google-cloud|@azure/" apps/api/package.json apps/web/package.json package.json
grep -rliE "aws-sdk|@google-cloud|@azure" apps/api/src apps/web/lib apps/web/app
```

Both returned zero matches — confirming §18's "no provider lock-in"
requirement is already satisfied (nothing to remove) and, as a side
effect, that no cloud-SDK credential-shaped code exists to have leaked
a secret in the first place. The existing `.env.example` files (checked
again this session) contain only placeholder strings
(`changeme-access-secret-min-32-chars`, `<set-in-secret-manager-or-local-env>`,
etc.), never a real value.

## 6. Database integration requirements (Phase 22 already covers backup/DR — not duplicated)

- `DATABASE_URL`: must carry `sslmode=require`/`verify-ca`/`verify-full`
  in production — enforced fail-closed today by
  `database-tls.validator.ts`, independently re-checked by
  `production-readiness-check.js` (same function, not a duplicated
  regex) — unchanged this phase.
- Connection pool sizing: each process calling
  `PrismaService.onModuleInit()` opens its own pool (Prisma's default:
  `num_physical_cpus * 2 + 1`, overridable via `DATABASE_URL`'s
  `connection_limit` parameter). With N API replicas + M worker
  replicas, **initial conservative recommendation** (not a measured
  value — no load test has been run against this schema at any
  replica count):
  - Set an explicit `connection_limit` per process type rather than
    relying on the CPU-derived default, which doesn't know it's sharing
    the database with the other process group.
  - Size the managed provider's `max_connections` to comfortably exceed
    `(API replicas × API connection_limit) + (worker replicas × worker
    connection_limit)`, with headroom for admin/migration tooling and
    the provider's own reserved connections.
  - Prefer PgBouncer (transaction-pooling mode) once replica counts grow
    past a handful — compatible with `SerializableTransactionRunner`'s
    use of explicit transactions + `SERIALIZABLE` isolation (this
    codebase uses no session-level feature like advisory locks or
    `LISTEN`/`NOTIFY` that transaction-mode pooling would break).
  - **Worker replicas provide little throughput benefit beyond 1** at
    current scale — `docs/deployment-architecture.md` §3 (unchanged)
    already documents that a second worker replica mostly re-does the
    first one's read work (the deposit-watcher's per-asset-network
    lease and the withdrawal-watcher's inherently serial "list all
    pending" design mean extra replicas don't parallelize useful work).
    Size the worker's connection pool for 1 replica unless a genuine
    sharding redesign is undertaken.
- Transaction timeouts: `SerializableTransactionRunner.run()` sets
  `maxWait: 5000ms, timeout: 10000ms` on every financial transaction —
  unchanged, re-verified this session by reading the current file.
- Readiness behavior: `GET /health/ready` returns 503 the instant the
  database is unreachable (`PrismaService.$queryRaw\`SELECT 1\``) —
  proven live in Phase 18's real outage-injection test, unchanged.
- **Transient connection-failure behavior — a real gap, found and
  documented in Phase 22, restated here because it's directly relevant
  to HA planning**: `SerializableTransactionRunner` retries
  serialization failures (SQLSTATE `40001`) only — it does **not**
  retry a transaction whose connection was lost mid-flight (e.g. during
  a managed-provider failover window). New queries after the failover
  completes work normally (Prisma's pool reconnects on its own); an
  **in-flight** transaction during the outage fails outright and
  propagates a real error to its caller. Not fixed this phase (same
  reasoning as Phase 22: safely retrying an entire multi-statement
  financial transaction after an indeterminate connection loss is a
  real design decision, not a quick patch).
- Migration execution model: `prisma migrate deploy` as a single,
  separate step before rolling out a new image — never inside
  container startup (both Dockerfile `CMD`s deliberately never run it) —
  unchanged, re-verified this session by reading both current
  Dockerfiles.

## 7. Container hardening — reviewed, no changes needed this phase

Both Dockerfiles were reviewed line-by-line this session against every
item in the Phase 23 hardening checklist:

| Check | apps/api (`runtime`/`worker`) | apps/web |
|---|---|---|
| Non-root execution | `USER node` on both targets | `USER node` |
| Minimal runtime image | `node:20-alpine`, `npm prune --omit=dev` drops all devDependencies (including `embedded-postgres`, which bundles a full Postgres binary with no business in a runtime image) | `node:20-alpine`, standalone output traces only the production dependency subset |
| No dev dependencies in the runtime layer | Confirmed — `deps`/`build` stages are separate from `runtime`/`worker`, which `COPY --from=build` only the pruned `node_modules` | Standalone tracing achieves the same by construction |
| No secrets baked into layers | Confirmed by reading every `COPY`/`ENV`/`ARG` line — only `NEXT_PUBLIC_*` build args (Next.js's own public-by-design convention) | Same |
| Deterministic install | `npm ci` (lockfile-exact), not `npm install` | Same |
| Healthchecks | `HEALTHCHECK` on all three images (`wget /health` for API/web, the heartbeat-file script for worker) | Present |
| Signal handling | `CMD ["node", ...]` exec form (not shell form) on every stage — signals reach the Node process directly, not a shell wrapping it | Same |
| Graceful shutdown | `main.ts` calls `app.enableShutdownHooks()` (Phase 16); `worker.main.ts` registers its own `SIGTERM`/`SIGINT` handlers calling `app.close()` | Next.js's own standalone server handles `SIGTERM` natively |
| Filesystem permissions | `--chown=node:node` on every `COPY --from=build` | Same |
| Exposed ports | `EXPOSE 4000` (API), `EXPOSE 3000` (web); worker deliberately has **no** `EXPOSE` (binds no port) | — |
| Production environment behavior | `ENV NODE_ENV=production` set on every runtime stage | Same |

**No Dockerfile change was made this phase** — every item above was
already correctly implemented in Phase 15/16. Rewriting a working
Dockerfile "for the sake of Phase 23" would be exactly the kind of
unnecessary churn the phase brief's own instructions warn against.

**Docker execution status: NOT EXECUTED.** Docker remains unavailable
in this environment, unchanged across every session that has worked on
this repository. Both Dockerfiles were reviewed for syntax/structure
only; CI's `docker-build` job (which includes the real boot +
`/health`/`/health/ready` smoke test, added Phase 16) is the actual
verification point, run on GitHub's own runners on every push — not
re-verified locally this session because the tooling to do so remains
absent here.

## 8. API / web / worker deployment units

| | API | Worker | Web |
|---|---|---|---|
| Startup command | `node apps/api/dist/main.js` | `node apps/api/dist/worker.main.js` | `node apps/web/server.js` |
| HTTP surface | Yes — port 4000, all public/admin/webhook routes | **None** | Yes — port 3000 |
| Health | `GET /health` (liveness), `GET /health/ready` (DB reachability + watcher staleness, informational) | Heartbeat file + `scripts/worker-healthcheck.js` (liveness only — says nothing about whether a scan is succeeding; see `GET /admin/watchers` for that) | HTTP 200 on `/` (Dockerfile's own healthcheck) |
| Environment requirements | `DATABASE_URL`, JWT secrets, `CORS_ALLOWED_ORIGINS`, `CHAIN_WATCHER_ENABLED=false`/`WITHDRAWAL_WATCHER_ENABLED=false` (unless the explicit single-process opt-in is used) | Same DB/secrets, plus `CHAIN_WATCHER_ENABLED=true`/`WITHDRAWAL_WATCHER_ENABLED=true`, `WORKER_HEARTBEAT_FILE` | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_ENVIRONMENT` (build-time) |
| Graceful shutdown | `app.enableShutdownHooks()` | Explicit `SIGTERM`/`SIGINT` handlers | Next.js standalone default |
| Scaling considerations | Horizontally scalable — stateless per-request, connection pool sizing per §6 | **Limited benefit beyond 1 replica** at current scale (§6) — the per-asset-network deposit lease and serial withdrawal-listing design mean extra replicas mostly duplicate read work, not parallelize it | Horizontally scalable, stateless |
| Rollback behavior | Redeploy previous image tag — no DB action needed (migrations are a separate step, never baked into the image's own startup) | Same | Same |

**The three remain independently deployable images/processes, exactly
as Phase 16 built them — nothing in this phase combines them.**

## 9. Worker reliability — reviewed, no new bug found beyond Phase 22's documented gap

Reviewed this session: `DepositWatcherService`'s per-asset-network CAS
lease (`BlockchainWatchCursor.lockedAt`/`lockedBy`, stale after 5
minutes), `WithdrawalWatcherService`'s lease-free design (status-guarded
`updateMany` calls make a second concurrent worker's redundant call a
safe no-op — no shared advancing cursor to protect, see that service's
own docblock), both services' graceful-shutdown `OnModuleDestroy`
(stop scheduling new polls, wait for any in-flight poll to finish),
`worker-healthcheck.js`'s heartbeat-staleness liveness check — all
unchanged since Phase 16/17's own review, re-verified by reading the
current files, not assumed.

**No new reliability bug was found this phase** beyond the one Phase 22
already discovered and documented (`SerializableTransactionRunner`'s
connection-failure retry gap, §6 above) — that finding is not
duplicated as a "new" one here, and it was not fixed in Phase 22 for
good reason (a real design decision about retrying financial
transactions after an indeterminate failure, not a quick patch) and
remains unfixed here for the same reason. No financial semantics were
touched by this phase.

## 10. Deployment strategy

1. **Migration first, as a single separate step**: `prisma migrate
   deploy` against the production database, before any new image is
   rolled out — never inside a container's own startup (unchanged
   Dockerfile design).
2. **API deployment**: rolling update, old and new versions may
   briefly coexist — schema changes must be additive/backward-
   compatible with the previous API version during this window (a
   generic rolling-deployment requirement, not specific to this
   codebase's schema history, which has had no genuinely breaking
   migration to date).
3. **Worker deployment**: independent of the API's rollout timing —
   redeploy separately; the lease/idempotency design (§9) already makes
   a brief overlap between old and new worker versions safe.
4. **Web deployment**: independent of both — the frontend only talks to
   the API over its public HTTP contract.
5. **Health checks**: wait for the new API/worker/web instances'
   healthchecks to pass before shifting traffic/marking the rollout
   complete (standard rolling-deployment practice, not new to this
   phase).
6. **Readiness verification**: `GET /health/ready` returning 200 before
   an instance receives real traffic — already how the existing
   readiness endpoint is designed to be used.
7. **Rollback strategy — application only (no schema change involved)**:
   redeploy the previous image tag for the affected process
   independently; no database action needed, since migrations are never
   baked into the image.
8. **Rollback strategy — a migration is involved**: **never blindly roll
   back a database migration** (Prisma generates no "down" migration to
   roll back to, and `docs/operations-runbook.md` §3 already documents
   why). Two legitimate paths only: (a) write and apply a new, forward
   migration that reverses the problematic schema change, or (b) if the
   migration already caused data loss a forward fix can't undo, this is
   now a disaster-recovery event — restore from the Phase 22 backup/DR
   architecture (`docs/database-backup-recovery.md` §5,
   `docs/disaster-recovery-runbooks.md` runbook L) — **not duplicated
   here, referenced.**
9. **Old/new version compatibility**: the API is the only component
   with a schema-facing contract; a migration that removes/renames a
   column the currently-deployed API version still reads is exactly the
   kind of non-additive change that must be split into an additive
   migration + a later cleanup migration once the old API version is
   fully retired — a standard expand/contract pattern, not new tooling
   this phase invents.

## 11. CI/CD — audited, no new workflow added

`.github/workflows/ci.yml` (re-read in full this session) already
satisfies every Phase 23 CI requirement:

- API build, web build, worker build — all covered by the root `npm run
  build` (compiles `apps/api`, `apps/web`, `packages/shared-types` — Nest's
  own build compiles `worker.main.ts` as part of `apps/api`'s `dist/`
  output, not a separate script).
- Tests — API unit + integration (real, ephemeral `embedded-postgres`,
  no external DB needed), web unit.
- Lint, typecheck — both workspaces.
- Prisma validation — schema syntax (hard gate) + migration-history diff
  (informational, documented reasoning for why it's non-blocking).
- Docker build configuration — all three targets (`runtime`, `worker`,
  web), **plus** an actual boot + `/health`/`/health/ready` smoke test
  of the built API image against a real (CI-throwaway) Postgres service
  container.

**No new deployment workflow was added** — the phase brief explicitly
says not to create one requiring cloud credentials, and the existing
`docker-build` job already validates deployment ARTIFACTS (the images
build and boot) without deploying anywhere. Adding a second, redundant
"build-only" workflow would duplicate what already exists for no
benefit. **No production secret is stored in GitHub Actions** — verified
by reading `ci.yml` in full: every credential-shaped value in the
`docker-build` job's smoke-test step is a hardcoded, clearly-fake,
CI-only placeholder string (documented as such in that job's own
comment), never a `secrets.*` reference to anything real.

## 12. Observability — deployment signals integrated with the existing boundary

| Signal | Status |
|---|---|
| API request IDs | INTERNAL SIGNAL IMPLEMENTED — `request-id.middleware.ts`, every response |
| Structured logs | INTERNAL SIGNAL IMPLEMENTED — `JsonLoggerService`, one JSON object per line |
| Worker heartbeat | INTERNAL SIGNAL IMPLEMENTED — heartbeat file + `worker-healthcheck.js` |
| Watcher health | INTERNAL SIGNAL IMPLEMENTED — `GET /admin/watchers`, `GET /admin/watchers/withdrawals` |
| Database readiness | INTERNAL SIGNAL IMPLEMENTED — `GET /health/ready` |
| Custody-provider health | INTERNAL SIGNAL IMPLEMENTED — `provider_request_failures_total`/`provider_ambiguous_operations_total` metrics |
| Compliance-provider health | INTERNAL SIGNAL IMPLEMENTED — same metrics boundary, `elliptic` provider tag |
| Reconciliation signals | INTERNAL SIGNAL IMPLEMENTED — `wallet.reconciliation.discrepancy_found`, `GET /admin/reconciliation/discrepancies` |
| Backup failure signal | INTERNAL SIGNAL IMPLEMENTED (Phase 22) — `infra/backups/backup-metadata.jsonl` |
| **External alerting sink** | **EXTERNAL ALERTING SINK REQUIRED — not connected, not invented.** Every signal above is real and queryable; none pages a human without a real vendor (CloudWatch/Datadog/whatever the chosen provider's own logging integrates with) actually wired to `MetricsService`'s interface. This is unchanged from Phase 13/16/22 — restated here as the deployment-readiness implication: **choosing a cloud provider in §2 does not, by itself, wire up alerting** — that is a separate integration step against whichever provider's monitoring product is chosen. |

No external monitoring vendor is selected or assumed by this phase.

## 13. Security — reviewed, no gate weakened

Reviewed this session, all unchanged and still correct: TLS enforcement
(`database-tls.validator.ts`), CORS (fails closed to an explicit
allowlist outside development), security headers (Helmet, CSP
deliberately omitted since this API serves no browser-rendered HTML),
rate limiting (global default + named per-endpoint presets),
authentication (`JwtAuthGuard`), authorization (`RolesGuard` +
Phase 20's `ActiveUserGuard`, both live-DB-re-checking, never trusting
the JWT's own claims), secret management (§5), database exposure (§4 —
never public), container privileges (§7 — non-root everywhere),
provider webhooks (signature-verified before parsing), admin endpoints
(SUPER_ADMIN-gated, audit-logged), production environment validation
(`env.validation.ts` unconditionally refuses `APP_ENVIRONMENT=production`
today). **Nothing in this phase weakens any of the above** — every
addition (§5's secret model, §4's network model) is documentation
describing how to deploy the existing, unmodified gates correctly, not
a code change to any of them.

## 14. Production readiness — gate extended, not weakened

`production-readiness-check.js` gained one new check this phase:

```
[NOT CONFIGURED] (P1) A production cloud provider and deployment architecture has been decided
```

Structural (does `docs/production-infrastructure-decision.md` exist),
never a claim that infrastructure is provisioned — the detail text
explicitly states this document is a comparison/recommendation, not a
selection, so the check can never read as green merely because the
document exists. **Every pre-existing P0 remains exactly as strict as
before**: production custody (`ProductionCustodyExecutor` still
unconditionally throws), production compliance
(`ComplianceGateFactory` still always forces `DeferredComplianceGate`
in production), and the Phase 22 managed-backup-infrastructure check
(still `NOT CONFIGURED`). **Status vocabulary now in consistent use
across the tool** (introduced Phase 22, extended here): `PASS` / `FAIL`
/ `NOT CONFIGURED` — no check in this codebase currently needs a
`WARN`/`BLOCKED`-specific status distinct from those three, so none was
invented merely to exhaust the phase brief's suggested vocabulary.

## 15. Staging parity — what local/staging represents, and what it does not

| | Local development (this repo, today) | What real STAGING would add | What real PRODUCTION requires beyond that |
|---|---|---|---|
| Database | `infra/docker-compose.yml`'s single local Postgres container, or `embedded-postgres` for tests | A persistent, externally-reachable Postgres instance — **never provisioned in any session that has worked on this repository** (`staging-preflight-check.js` has always reported this missing) | A managed provider (§2) with real HA/PITR/off-site backup |
| Process orchestration | Manually-started local processes (`npm run dev:api`/`dev:worker`/`dev:web`), or nothing (Docker unavailable) | Real containers on a real orchestrator (ECS/Cloud Run/Container Apps/whatever §2 resolves to) | Same, at production scale/replica count with real rolling-deployment behavior |
| Observability | Console-printed structured JSON logs, nothing shipped anywhere | Logs shipped to a real aggregator, still no alerting necessarily wired | Full §12 — internal signals + a connected external alerting sink |
| Provider integration | `NoopEmailProvider`/`ManualBroadcastExecutor`/`DeferredComplianceGate` (sandbox defaults), or the REAL Fireblocks/Elliptic **sandbox** APIs if credentials are configured (never done in any session) | The same real sandbox provider integrations, exercised against a persistent environment | Real PRODUCTION custody/compliance provider integrations — **structurally blocked today** (`ProductionCustodyExecutor` throws, `ComplianceGateFactory` forces `DeferredComplianceGate`), by design, until those are genuinely built and reviewed |
| TLS | None (local HTTP) | Should be enabled for realism, strongly recommended | Mandatory, fail-closed (`database-tls.validator.ts`) |

**Local development and even a real staging deployment are not
production-equivalent** — this table exists specifically so that claim
is never made implicitly by omission. Phase 18's real staging drill
(four real OS processes, real Postgres, real HTTP requests) is the
closest this repository has come to "staging," and even that was
explicitly local/throwaway, not a persistent externally-reachable
environment.

## 16. Failure testing this session

| Test | Result |
|---|---|
| Invalid `DATABASE_URL` | Covered by existing `env.validation.spec.ts` (unit-level, re-run this session as part of the full suite — passes) |
| Missing production secrets | Same — `assertProductionEmailConfigured`/JWT-secret-length checks, all still passing |
| Migration guard (destructive command refused against production env) | Covered by `guard-destructive-migration.integration-spec.ts` (Phase 17, spawns the real script as a real subprocess) — re-run this session, passes |
| Container configuration validation | `bash -n` syntax-check only on Dockerfiles is not meaningful (Dockerfiles aren't shell scripts) — **structural review only** (§7); actual `docker build`/`docker run` — **NOT EXECUTED**, Docker unavailable |
| API/worker DB outage, readiness behavior, worker restart | **Already real-executed in Phase 18** (`pg_ctl stop -m immediate` against a real live staging Postgres while API/worker were running) — not re-run this session (out of proportion to repeat a real outage-injection drill for a documentation-and-decision phase); its passing result stands, unchanged, cited from `docs/staging-deployment-validation.md` §13. |

**Nothing here was tested against the active development database
destructively** — every test above either already existed (unit/
integration suites against ephemeral `embedded-postgres`) or was a
previously-executed, cited result, not a new destructive action this
session.

## 17. Provisioning checklist (for whoever eventually provisions this)

- [ ] Cloud provider chosen from §2's comparison (or a different one,
      with the same comparison criteria applied)
- [ ] Managed PostgreSQL instance provisioned, private-networked (§4),
      TLS-enforced
- [ ] Automated backups + PITR enabled on the chosen provider (Phase 22
      documents the RPO/RTO targets to hold this against)
- [ ] Secret manager configured; every secret in §5 migrated off local
      env files
- [ ] Container hosting target chosen and configured for all three
      deployment units (§8), each independently deployable
- [ ] Load balancer + TLS certificate provisioned
- [ ] Security groups/firewall rules configured per §4 (no public DB,
      no "allow all")
- [ ] `DATABASE_URL` (with `connection_limit` set per §6) supplied to
      API and worker as secret-manager-backed env vars
- [ ] Migration run (`prisma migrate deploy`) as the first deployment
      step
- [ ] Health/readiness endpoints confirmed reachable by the
      orchestrator's own probes
- [ ] External alerting sink connected to `MetricsService`'s interface
      (§12)
- [ ] Restore drill re-run against the REAL chosen provider's backup
      mechanism (Phase 22's drill proved the schema/engine; the real
      provider's own restore path has never been exercised)
- [ ] `production-readiness-check.js --with-db` run clean (still
      correctly blocked on custody/compliance until those are real)

## 18. Unresolved decisions

1. Which of AWS/GCP/Azure (§2) — a business decision, not made here.
2. Container hosting product within the chosen provider (ECS vs. App
   Runner; Cloud Run vs. GKE; Container Apps vs. AKS).
3. Whether/when to enable the chosen provider's HA tier (§2's Multi-AZ/
   regional row) — a cost/RTO tradeoff, informed by
   `docs/production-database-readiness.md` §2's proposed (not yet
   accepted) RPO/RTO targets.
4. Which external alerting vendor (§12) — genuinely unstarted.
5. Production custody and compliance provider selection — **entirely
   out of this phase's scope**, structurally blocked by design
   (`ProductionCustodyExecutor`, `ComplianceGateFactory`), unchanged.
6. Exact `connection_limit`/`max_connections` values (§6) — conservative
   initial guidance given, not a measured/load-tested value.
