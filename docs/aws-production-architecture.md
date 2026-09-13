# AWS Production Architecture — Phase 25

**Status of everything in this document: DESIGNED, NOT PROVISIONED.**
No AWS account, resource, or credential exists for this project. Every
item below is either explicitly labeled **REQUIRES HUMAN APPROVAL**
(a decision only the human operator can make — account creation,
region, budget, go-live) or is a specification for what would be
built once that approval exists. Nothing in this phase creates an AWS
resource, spends money, or requests credentials.

This document turns `docs/production-infrastructure-decision.md`'s
Phase 24 recommendation (AWS, ECS Fargate + RDS) into an executable
architecture. It does not re-litigate the provider choice — see that
document for the comparison and rationale. It does not duplicate
`docs/aws-network-design.md` (subnet/route/security-group detail),
`docs/aws-iam-and-secrets.md` (IAM/secrets detail), or
`docs/aws-deployment-runbook.md` (ECS service/CI-CD detail) — each is
the authoritative source for what it covers, referenced here rather
than repeated.

## 1. Target architecture diagram

```
                         Route 53 (DNS)                    DESIGNED, NOT PROVISIONED
                              │
                              │ HTTPS (443)
                              ▼
                    ┌──────────────────────┐
                    │  ACM certificate       │            DESIGNED, NOT PROVISIONED
                    │  (TLS termination)     │
                    └───────────┬───────────┘
                                │
                    ┌───────────┴───────────┐
                    │  Application Load       │           DESIGNED, NOT PROVISIONED
                    │  Balancer (public       │
                    │  subnets, 2+ AZ)        │
                    └─────┬─────────────┬────┘
                          │             │
              host/path routing    host/path routing
                          │             │
                          ▼             ▼
              ┌──────────────────┐ ┌──────────────────┐
              │  ECS: verdictvaut- │ │  ECS: verdictvaut- │   DESIGNED, NOT PROVISIONED
              │  web (private      │ │  api (private      │
              │  subnet)           │ │  subnet, incl.      │
              │                    │ │  /webhooks/*)       │
              └──────────────────┘ └─────────┬────────┘
                                              │ DATABASE_URL (TLS, private)
                                              ▼
                                ┌───────────────────────┐
                                │  Isolated DB subnets     │   DESIGNED, NOT PROVISIONED
                                │  RDS for PostgreSQL 16   │
                                │  (Multi-AZ)              │
                                └─────────────▲───────────┘
                                              │ DATABASE_URL (TLS, private)
              ┌──────────────────┐           │
              │  ECS: verdictvaut- │──────────┘
              │  worker (private   │           DESIGNED, NOT PROVISIONED
              │  subnet, NO ALB     │
              │  target, NO port)   │
              └─────────┬──────────┘
                        │ outbound only, via NAT gateway
                        ▼
        blockchain RPC · Fireblocks (sandbox today) · Elliptic (sandbox today) · Postmark
```

Every box above is a specification, not a deployed resource. Full
subnet/AZ/route-table/security-group detail: `docs/aws-network-design.md`.

## 2. Public vs. private components

| Component | Exposure | Rationale |
|---|---|---|
| Route 53 hosted zone, ACM certificate | Public (DNS/cert are inherently public artifacts) | Standard |
| ALB | Public subnets, internet-facing | The only component with a public IP in this architecture |
| ECS `verdictvaut-web` | Private subnet, reachable only from the ALB's security group | No direct internet route; matches Phase 24's tightened posture (not Phase 23's original "public subnet" draft) |
| ECS `verdictvaut-api` | Private subnet, reachable only from the ALB's security group — **including the Fireblocks webhook route**, which rides the same ALB/domain as the rest of the API | Same reasoning; the webhook is public-reachable through the ALB, never by giving the API task its own public IP |
| ECS `verdictvaut-worker` | Private subnet, **no ALB target group, no listener, no port exposed at all** | Matches `worker.main.ts`'s own no-HTTP-surface design (unchanged); required by this phase's brief ("Do not expose worker HTTP ports") |
| RDS for PostgreSQL | Isolated DB subnets, no route to/from the internet | **Required rule, satisfied by design**: never publicly accessible |
| Secrets Manager, CloudWatch, ECR | AWS-managed, reached via VPC endpoints or NAT-gateway egress — not "public" in the internet-facing sense, but never holds a public IP for this project's resources | See `docs/aws-iam-and-secrets.md` |

## 3. Ingress

| Path | Terminates at | Protocol |
|---|---|---|
| Browser/API client → Route 53 → ALB | ALB | HTTPS (443) only — HTTP (80) redirects to HTTPS, never served directly (§9 of `docs/aws-deployment-runbook.md`) |
| ALB → `verdictvaut-web` | Web ECS task, port 3000 | Plain HTTP inside the VPC (ALB already terminated TLS) |
| ALB → `verdictvaut-api` (incl. `/webhooks/fireblocks`) | API ECS task, port 4000 | Plain HTTP inside the VPC; the webhook route is signature-verified at the application layer (RSA-SHA512, unchanged, re-verified this session by reading `fireblocks-webhook.controller.ts`) — the network layer does not attempt to replicate that verification |
| — | `verdictvaut-worker` | **No ingress path exists or is designed.** |

## 4. Egress

| Origin | Destination | Via |
|---|---|---|
| `verdictvaut-api` | RDS | In-VPC, no NAT needed |
| `verdictvaut-worker` | RDS | In-VPC, no NAT needed |
| `verdictvaut-api` | Fireblocks, Elliptic, Postmark, Secrets Manager (if no VPC endpoint) | NAT gateway |
| `verdictvaut-worker` | Blockchain RPC endpoints, Fireblocks | NAT gateway |
| `verdictvaut-web` | `verdictvaut-api`'s public DNS (same path a browser uses) | NAT gateway, or a VPC-internal route if a private ALB listener is added later (not designed this phase) |

No egress destination is a bare IP address anywhere in this design —
every one is DNS/configured-URL reached, matching
`rpc-config.service.ts`'s existing pattern (unchanged).

## 5. Security boundaries

Full security-group/firewall detail: `docs/aws-network-design.md` §5.
Summary: ALB security group accepts 443 from the internet only; the
web/API task security groups accept traffic from the ALB security
group only; the worker task security group accepts **no** inbound
traffic; the RDS security group accepts 5432 from the API and worker
task security groups only, never from `0.0.0.0/0`, and RDS is never
marked publicly accessible.

## 6. Database access boundary

Only the API and worker ECS tasks ever hold a `DATABASE_URL`. No
other AWS service, IAM principal, or component in this design is
granted network or credential access to RDS. TLS is enforced
fail-closed by the existing `database-tls.validator.ts`
(`sslmode=require`/`verify-ca`/`verify-full`) whenever
`APP_ENVIRONMENT=production` — unchanged, re-verified this session.
Full RDS contract: `docs/aws-disaster-recovery.md` §1.

## 7. Worker isolation

The worker (`apps/api/Dockerfile --target worker`,
`worker.main.ts`) is designed as its own ECS service
(`verdictvaut-worker`), independently deployable from
`verdictvaut-api` — exactly as Phase 16 built it and Phase 23/24
already documented. AWS infrastructure does not change this: no
target group, no listener rule, no security-group inbound rule, and
no public/private DNS record is designed for the worker service.
`watcher-boundary.guard.ts` continues to enforce, at the application
level, that the API process refuses to run watchers unless explicitly
opted in — the AWS design does not rely on network isolation alone.

## 8. Webhook ingress

`POST /webhooks/fireblocks` is deliberately reachable from the public
internet (Fireblocks' own infrastructure must be able to reach it) —
it rides through the same ALB and the same `verdictvaut-api` ECS
service as every other API route; **no separate ALB, listener, or
public endpoint is designed for it.** Signature verification
(RSA-SHA512, before any JSON parsing) and `PROVIDER_WEBHOOK_THROTTLE`
(300/min) remain the actual security boundary — both are existing,
unchanged application code, re-verified this session by reading
`fireblocks-webhook.controller.ts` and `throttle-presets.ts`.

## 9. AWS service mapping

| Service | Purpose | VerdictVaut component | Required configuration | Security implications | Mandatory / optional |
|---|---|---|---|---|---|
| **ECS Fargate** | Serverless container hosting for web/API/worker | All three deployment units | Task definitions (CPU/mem/image/env/secrets), 3 services, no EC2 instance management | Task role scoped per service (§`docs/aws-iam-and-secrets.md`); no SSH surface (Fargate has no accessible host) | **Mandatory** — this is the container-hosting decision itself |
| **Application Load Balancer** | TLS termination, public ingress, host/path routing to web vs. API | Web, API (worker excluded) | HTTPS listener with ACM cert, HTTP→HTTPS redirect listener, 2 target groups | Only component with a public IP in this design; must never route to the worker | **Mandatory** for web/API. The worker deliberately never gets a target group. |
| **RDS for PostgreSQL** | Managed primary database | API, worker | Postgres 16, Multi-AZ, isolated subnet group, `force_ssl` parameter, automated backups + PITR, deletion protection | Never publicly accessible; security group scoped to API/worker task SGs only | **Mandatory** |
| **Secrets Manager** | Stores `DATABASE_URL`, JWT secrets, Fireblocks/Elliptic/Postmark credentials, webhook secrets | API, worker (injected via ECS task-definition `secrets`) | One secret per credential, IAM resource policies scoping which task role may read which secret | Secrets never baked into images, never in CI logs, never in app logs (§`docs/aws-iam-and-secrets.md`) | **Mandatory** |
| **CloudWatch (Logs + Alarms)** | Log aggregation for all 3 services + ALB access logs; alarms on the signals in §12/§13 below | All 3 ECS services, ALB | `awslogs` log driver per task definition, log group per service, retention policy, alarm definitions (optional, unconfigured — see §13) | Structured JSON logs already redact sensitive fields (`JsonLoggerService`, unchanged) before they ever reach CloudWatch | **Mandatory** for logs; **optional** for alarms until a human authorizes real paging |
| **S3** | ALB access-log destination; optionally, an off-site encrypted copy of local `pg_dump` backups until RDS-native backups are the sole mechanism | ALB (access logs); operationally, not application code | Bucket with default encryption, bucket policy restricting write access to the ALB service principal / backup process only, lifecycle policy for retention | Must never be public; access-logging buckets have a well-documented AWS-required bucket policy shape | **Optional** — ALB access logs are a recommended hardening step, not a functional requirement; RDS's own automated backups (§`docs/aws-disaster-recovery.md`) do not require S3 directly |
| **Route 53** | DNS for the application's public domain(s) | Web, API (if a separate API subdomain is used) | Hosted zone, A/ALIAS records pointing at the ALB | Domain/DNS control — a real operational responsibility, not just a technical one (§3 region/domain ownership) | **Mandatory** if a custom domain is used; **optional** if the ALB's own AWS-provided DNS name is acceptable for an initial launch (not recommended for a real product, but technically functional) |
| **ACM** | Free, AWS-managed TLS certificate for the ALB | ALB | DNS or email validation against the chosen domain | Auto-renewing, removes manual certificate rotation as an operational burden | **Mandatory** if TLS is terminated at the ALB (it must be — see `database-tls.validator.ts`'s own production requirement that nothing in this stack ever serves plaintext HTTP in production) |
| **VPC** | Network isolation boundary for everything above | Everything | 1 VPC, 2+ AZs, 3 subnet tiers (public/app-private/db-private) | The entire network security model in `docs/aws-network-design.md` depends on this | **Mandatory** |
| **Security groups** | Stateful firewall rules between tiers | ALB, web/API/worker tasks, RDS | 5 groups minimum (§`docs/aws-network-design.md` §5) | The actual least-privilege network enforcement mechanism | **Mandatory** |
| **IAM** | Roles/policies for ECS execution, per-service task roles, CI/CD deploy role | All ECS services, CI/CD | Least-privilege roles per `docs/aws-iam-and-secrets.md` §2 | The actual least-privilege *identity* enforcement mechanism (distinct from network) | **Mandatory** |
| **ECR** | Container image registry for web/API/worker images | CI/CD, ECS | 3 repositories, immutable tagging, vulnerability scanning enabled | Image provenance/integrity — see `docs/aws-deployment-runbook.md` §3 | **Mandatory** once any image is pushed anywhere real — not required for this phase, which pushes nothing |

No configuration above has been deployed. This table documents intent
and requirement, not a deployed state — restated because this phase's
brief explicitly warns against implying otherwise.

## 10. Region

**No production region is selected by this document — REQUIRES HUMAN
APPROVAL.**

Selection criteria for whoever makes this decision:

- **Data residency**: does VerdictVaut have (or will it have) users or
  regulatory obligations tying data to a specific jurisdiction (e.g.
  EU users implying an EU region)? This repository has no visibility
  into VerdictVaut's actual user base or regulatory posture — genuinely
  unknown here, not omitted by oversight.
- **Latency to blockchain RPC/custody/compliance providers**: the
  worker's poll loop and the API's synchronous compliance-check calls
  are latency-sensitive in aggregate (poll frequency, not single-request
  latency, dominates), but not latency-critical for correctness — the
  existing bounded-retry-with-jitter design
  (`chain-adapters/retry.util.ts`) already tolerates ordinary network
  latency. Fireblocks and Elliptic are both accessed over the public
  internet today (no verified region-pinning requirement for either
  found this session); most major blockchain RPC providers offer
  multi-region endpoints, so no single AWS region is uniquely
  disqualified on this basis alone, as far as could be verified this
  session.
- **Disaster recovery**: a genuinely separate DR region (distinct from
  the primary) is a larger commitment (cross-region replication,
  RTO/RPO analysis distinct from single-region Multi-AZ — see
  `docs/aws-disaster-recovery.md` §5) than this phase attempts to
  decide. The primary-region choice should keep at least one
  same-country/same-legal-jurisdiction alternate region available for
  a future DR expansion, without that constraining the primary choice
  today.
- **AWS service availability**: not every AWS region offers every
  service/instance type at the same price or availability tier —
  verify RDS Multi-AZ, Fargate, and Secrets Manager are all available
  in whatever region is chosen (all three are broadly available across
  AWS's standard regions as of this session's general knowledge, not
  independently re-verified against a specific region list this
  session).

**If an example is useful for illustrating the rest of this document's
subnet/AZ math: `us-east-1` — EXAMPLE ONLY, not a recommendation, not
selected, not provisioned.** `docs/aws-network-design.md` uses this
same EXAMPLE-ONLY region purely to make AZ names concrete (e.g.
`us-east-1a`/`us-east-1b`) — substitute the real chosen region's own
AZ names when this is actually provisioned.

## 11. Custody / compliance boundary — preserved, not bypassed

**This phase introduces no blockchain signing code, no private key
storage, and no change to any provider abstraction.** Verified this
session by reading the current source, not assumed:

- `WithdrawalExecutor` (`wallet/executors/withdrawal-executor.interface.ts`)
  and `ProductionCustodyExecutor` (`wallet/executors/production-custody.executor.ts`,
  read in full this session) — the latter still unconditionally
  `throw`s. AWS infrastructure changes nothing about this; ECS Fargate
  has no mechanism to "work around" an application-level `throw`, and
  none is designed here.
- `WithdrawalComplianceGate` and `ProductionSafetyGate`
  (`wallet/production-safety.gate.ts`, read in full this session) —
  still refuses to let `APP_ENVIRONMENT=production` finish booting
  unless a real (non-`DeferredComplianceGate`) compliance gate is
  bound **and** real, enabled PRODUCTION-environment
  `ComplianceProviderConfig`/`CustodyProviderConfig` rows exist. This
  check runs at NestJS bootstrap, inside the container, regardless of
  which cloud host runs that container — AWS does not and cannot
  short-circuit it.
- **No AWS KMS key, CloudHSM, or any key-management service is
  provisioned or designed for blockchain private key custody in this
  phase.** If a self-custody signing design is ever pursued (as
  opposed to a third-party custody provider like Fireblocks), that is
  a distinct, much larger security decision explicitly out of scope
  here — this document neither recommends nor designs it.
- Secrets Manager (§`docs/aws-iam-and-secrets.md`) stores API
  *credentials* for Fireblocks/Elliptic (bearer tokens, HMAC keys) —
  never a blockchain private key, which this codebase has never held
  and does not design AWS infrastructure to hold now.

## 12. Email boundary — preserved

The Phase 20 `EmailProvider` abstraction
(`PostmarkEmailProvider`/`NoopEmailProvider`) is unchanged. Production
email remains blocked exactly as `env.validation.ts`'s
`assertProductionEmailConfigured` already enforces (unchanged,
re-verified this session) until a real Postmark **production** server
token exists (distinct from any sandbox token), the sending domain is
verified with Postmark, and SPF/DKIM records are published — none of
which this phase performs. **No email is sent by this phase.**
`EMAIL_FROM_ADDRESS`'s domain-verification and SPF/DKIM requirements
are Postmark/DNS-side steps, not AWS infrastructure — noted here only
because Route 53 (§9) would be the natural place to host the SPF/DKIM
DNS records if this project's domain is ever migrated to Route 53; no
such migration is designed or assumed.

## 13. Observability mapping

Extends `docs/observability-and-alerting.md` (internal signals) and
`docs/production-infrastructure-decision.md` §12 (the Phase 24
CloudWatch-as-optional-sink note) with the concrete per-service mapping
this phase's brief asked for:

| Internal signal | AWS destination | Status |
|---|---|---|
| API structured JSON logs | CloudWatch Logs, `awslogs` driver, log group `/ecs/verdictvaut-api` (example naming — not provisioned) | DESIGNED |
| Worker structured JSON logs + heartbeat file | CloudWatch Logs, log group `/ecs/verdictvaut-worker` | DESIGNED |
| Web logs (Next.js server output) | CloudWatch Logs, log group `/ecs/verdictvaut-web` | DESIGNED |
| ALB access logs | S3 bucket (§9 — optional but recommended) | DESIGNED, OPTIONAL |
| Database metrics (CPU, connections, storage, replica lag if applicable) | RDS's own CloudWatch metrics (automatic once RDS exists — no application code involved) | DESIGNED |
| Worker heartbeat / watcher staleness | Already-implemented `GET /admin/watchers`; CloudWatch has no native visibility into this without a log-based metric filter on the structured logs above | DESIGNED (log-based metric filter, not a native RDS/ECS metric) |
| Deposit/withdrawal watcher failures | `wallet.deposit_watcher.scan_failed`/`wallet.withdrawal_watcher.*` — log-based metric filters on the JSON log lines | DESIGNED |
| Reconciliation discrepancies | `wallet.reconciliation.discrepancy_found` — same | DESIGNED |
| Custody/compliance provider failures | `provider_request_failures_total` — same | DESIGNED |
| Backup failures | `infra/backups/backup-metadata.jsonl` today (local-tooling-only, unchanged) — once RDS-native automated backups are provisioned, backup *success* is an RDS/CloudWatch event; backup *failure* alerting on RDS-native backups is provider-native, not this repository's own log file | DESIGNED for RDS-native; local tooling's own file-based signal is **unchanged, still not wired to any external sink** |
| Production readiness gate result | Not currently shipped anywhere — `production-readiness-check.js` is a CLI tool, run manually or in CI; no CloudWatch integration is designed for its own pass/fail result in this phase (it fails the CI job it runs in today, which is itself visible in GitHub Actions, not CloudWatch) | Not designed — out of scope, no evidence this needs a CloudWatch-specific integration beyond CI's own pass/fail |

**No dashboard is designed or built.** The underlying data (structured
logs, RDS metrics, ECS task health) is real and queryable once shipped;
no specific CloudWatch Dashboard/Grafana layout is assumed.

## 14. Alerting — required conditions and severities (not configured)

Per this phase's brief, listed here with the existing internal signal
each maps to (§13 above / `docs/observability-and-alerting.md` §2).
**No alerting service (paid or free) is configured by this phase** —
this is a specification of what a human would wire up, using
CloudWatch Alarms (§9's "optional" note) or any other aggregator, once
authorized.

| Severity | Condition | Existing signal |
|---|---|---|
| CRITICAL | Reconciliation discrepancy (severity=CRITICAL) | `wallet.reconciliation.discrepancy_found` / `settlement.collateral_reconciliation.discrepancy_found` |
| CRITICAL | Custody provider failure | `provider_request_failures_total` (custody), `provider_ambiguous_operations_total` |
| CRITICAL | Database unavailable | `GET /health/ready` 503, RDS CloudWatch status metrics |
| CRITICAL | Worker stopped | Heartbeat file staleness / ECS task health (a stopped Fargate task is itself an ECS event, separately alarmable) |
| CRITICAL | Backup failure | `infra/backups/backup-metadata.jsonl` (local tooling) or RDS-native automated-backup failure event, once real |
| CRITICAL | Production readiness failure | `production-readiness-check.js` exit code — a CI/CD gate today (§`docs/aws-deployment-runbook.md` §7), not a CloudWatch alarm |
| HIGH | Deposit processing failures | `wallet.deposit_watcher.scan_failed` |
| HIGH | Withdrawal confirmation failures | `wallet.withdrawal_watcher.poll_failed`/`confirmation_check_failed`, `marked_failed` |
| HIGH | Compliance failures | `provider_request_failures_total` (Elliptic-tagged) |
| HIGH | Elevated API 5xx | ALB target-group 5xx metric (native once the ALB exists) or CloudWatch Logs metric filter on structured error logs |
| MEDIUM | Authentication abuse | `AuthService.login()`'s `failedLoginAttempts`/`lockedUntil` — **no dedicated metric counter exists today** (a real, previously-documented gap — `docs/production-deployment-plan.md` §9, unchanged this phase) |
| MEDIUM | Elevated latency | ALB target-group response-time metric (native) |
| MEDIUM | Rate-limit spikes | HTTP 429 responses — **no dedicated internal counter exists today** (same gap category as above) |

No paid alerting service is selected. CloudWatch Alarms (included in
core AWS pricing, distinct from a third-party paid vendor) is the
natural first destination if/when this is wired up, consistent with
Phase 24's "optional recommendation, not a vendor decision" framing —
restated, not re-argued, here.
