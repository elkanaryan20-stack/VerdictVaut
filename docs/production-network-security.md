# Production Network Security — Phase 24

Concrete network-security model for the target production architecture
described in `docs/production-infrastructure-decision.md` §3
(recommended, **not provisioned**: AWS, ECS Fargate + RDS for
PostgreSQL). This document does not duplicate that file's provider
comparison or recommendation rationale — it only makes the network
boundary concrete enough to actually provision correctly once
authorized.

Every claim is labeled the same way as the decision document:
**IMPLEMENTED** (true today, in this repository's code), **REQUIRES
PROVISIONING** (needs a real cloud resource that does not exist),
**RECOMMENDED CONFIGURATION** (this document's own guidance for
whoever provisions it — not a claim it exists).

## 1. Public vs. private segments

| Segment | Contents | Reachability |
|---|---|---|
| Public subnets (2+, multi-AZ) | Application Load Balancer only | Internet-facing, port 443 only |
| Private subnets (2+, multi-AZ) | Web, API, and worker ECS Fargate tasks | No direct internet route in; outbound via NAT gateway only |
| Isolated DB subnets (2+, multi-AZ, no NAT route) | RDS for PostgreSQL | No internet route in **or out**; reachable only from the private application subnets' security group |

**No component of this architecture is ever placed in a public
subnet except the load balancer itself.** This is a deliberate
tightening from `docs/production-infrastructure-decision.md`'s
original Phase 23 diagram (which described web/API as "public subnet
/ public ingress") — putting the application containers themselves in
private subnets behind the ALB is the AWS-recommended pattern and
costs nothing this repository's architecture needs a public IP for
(the containers make no assumption about their own subnet placement).

## 2. Ingress requirements

| Path | Source | Destination | Port | Auth |
|---|---|---|---|---|
| Web traffic | Internet | ALB | 443 (TLS) | None at the network layer — app-level session/JWT |
| ALB → Web service | ALB security group | Web ECS tasks | 3000 | None (internal) |
| ALB → API service (incl. all `/auth`, `/wallet`, `/admin`, etc. routes) | ALB security group | API ECS tasks | 4000 | `JwtAuthGuard`/`RolesGuard`/`ActiveUserGuard` at the app layer, per route — **IMPLEMENTED**, unchanged by this phase |
| Fireblocks webhook (`POST /webhooks/fireblocks`) | Internet (Fireblocks' own infrastructure), via the same ALB/domain as the rest of the API | API ECS tasks | 4000 | Deliberately outside `JwtAuthGuard` — signature-verified (RSA-SHA512, `Fireblocks-Signature` header) **before** JSON parsing, `PROVIDER_WEBHOOK_THROTTLE` (300/min) applied — **IMPLEMENTED**, `fireblocks-webhook.controller.ts` |
| Admin routes (`/admin/**`) | Same ALB, no separate ingress path | API ECS tasks | 4000 | `RolesGuard` (SUPER_ADMIN only) at the app layer — **IMPLEMENTED**. No network-level IP-allowlist for admin routes exists in this repository; if the operator wants one, it would be an additional ALB listener rule or a separate internal-only ALB — **RECOMMENDED CONFIGURATION**, not built (would require deciding a real admin-access source, e.g. a VPN/bastion CIDR, which this repository has no visibility into) |
| Worker service | — | — | — | **No inbound rule of any kind** — the worker binds no port (`worker.main.ts`'s own design, unchanged) |
| Database | API/worker security group only | RDS | 5432 | TLS (`sslmode=require`, enforced fail-closed by `database-tls.validator.ts`) + IAM/password auth |

**Never an inbound rule from `0.0.0.0/0` on anything except the ALB's
own 443 listener.** This includes the database security group, which
must never list the internet or a `/0` CIDR as a source under any
configuration — RDS must not be marked "publicly accessible" at all.

## 3. Egress requirements

| Origin | Destination | Purpose |
|---|---|---|
| API | RDS (private, in-VPC — no NAT needed) | `DATABASE_URL` |
| API | Fireblocks API (sandbox today; production if/when authorized) | Withdrawal request/approval flow, `FireblocksCustodyAdapter` |
| API | Elliptic API (sandbox today) | Compliance/address-risk screening, `EllipticAddressRiskGate` |
| API | Postmark API | Verification email delivery, `PostmarkEmailProvider` |
| API | Secrets Manager | Resolving `env:`-scheme secret references' underlying values at container start (via ECS's own secret-injection, not an app-level call — see `docs/production-secret-management.md`) |
| Worker | RDS (private, in-VPC) | `DATABASE_URL` |
| Worker | Blockchain RPC endpoints (`rpc-config.service.ts`'s configured URLs — Bitcoin/Ethereum/Base/Solana/XRPL testnet today) | Deposit/withdrawal watchers |
| Worker | Fireblocks API | `WithdrawalWatcherService` poll-based confirmation checking |
| Web | API (via the ALB's own public DNS, same as any browser client — `NEXT_PUBLIC_API_URL`) | Server-side rendering/API proxying, unchanged from today's local-dev topology |

All non-RDS egress above leaves the VPC through a NAT gateway in a
public subnet — the private subnets themselves have no direct internet
route. **No egress destination is ever a bare IP address** — every one
above is reached by DNS/configured URL, matching
`rpc-config.service.ts`'s existing configurable-endpoint pattern
(re-verified this session, unchanged since Phase 23).

Recommended (not implemented — no cloud account exists to configure
this in): scope egress security-group rules per service rather than
one shared "allow all outbound" rule — e.g. the worker's security
group needs blockchain RPC + Fireblocks egress but not Postmark; the
API's needs Postmark + Fireblocks + Elliptic but has no reason to reach
arbitrary blockchain RPC hosts outside its own on-demand reconciliation
paths. This is a hardening recommendation, not a requirement blocking
launch — an "allow all outbound, deny all inbound except the rules
above" posture is a legitimate, common starting point too.

## 4. TLS requirements

| Hop | Requirement | Status |
|---|---|---|
| Internet → ALB | TLS 1.2+, ACM-issued certificate | REQUIRES PROVISIONING |
| ALB → application containers | Plain HTTP is acceptable inside the VPC (the ALB terminates TLS) — this repository's `apps/api`/`apps/web` HTTP servers do not themselves terminate TLS, unchanged from Phase 23 | IMPLEMENTED (app doesn't need to change) |
| Application → RDS | `sslmode=require`/`verify-ca`/`verify-full` on `DATABASE_URL`, enforced fail-closed whenever `APP_ENVIRONMENT=production` | IMPLEMENTED — `database-tls.validator.ts`, re-verified this session by reading the current file (unchanged since Phase 13) |
| Application → third-party providers (Fireblocks/Elliptic/Postmark/RPC) | HTTPS-only — `apiBaseUrl` on both `CustodyProviderConfig` and `ComplianceProviderConfig` requires `https://` at the DB-config level (Phase 14B, SSRF defense-in-depth) | IMPLEMENTED, re-verified this session |

## 5. Security groups / firewall rules — summary

| Security group | Inbound | Outbound |
|---|---|---|
| ALB SG | 443 from `0.0.0.0/0` (and `::/0` if IPv6 is enabled) | To web/API task SGs only |
| Web task SG | From ALB SG only, port 3000 | To API's public DNS (443) — no VPC-internal call needed since the browser talks to the API directly for most calls; SSR calls go over the same public path unless a private ALB listener is added later |
| API task SG | From ALB SG only, port 4000 | To RDS SG (5432), NAT gateway (443, for Fireblocks/Elliptic/Postmark/Secrets Manager) |
| Worker task SG | **No inbound rule** | To RDS SG (5432), NAT gateway (443, for RPC/Fireblocks) |
| RDS SG | From API task SG + worker task SG only, port 5432 | N/A (isolated subnet, no outbound needed) |

## 6. Admin access

No network-level admin access path (VPN, bastion, IP allowlist) is
defined by this document — **this is a real, open decision**, not an
oversight: SUPER_ADMIN routes are already protected at the application
layer (`RolesGuard`, live DB re-check, never trusts the JWT alone —
unchanged, re-verified this session), which is sufficient for launch
without an additional network control. Adding one (a separate internal
ALB, a VPN-only listener rule, or an IP allowlist on the existing
ALB's admin path) is a defense-in-depth hardening step for whoever
operates this in production to decide, informed by their own
operational model (which this repository has no visibility into — no
real operations team, on-call rotation, or corporate network topology
is assumed or invented here).

## 7. What this document deliberately does not do

- Does not provision any security group, VPC, or subnet — every rule
  above is a specification for whoever provisions AWS resources once
  authorized.
- Does not invent a WAF/DDoS-protection configuration — AWS WAF/Shield
  are available and compatible with this architecture (ALB is a
  standard WAF attachment point) but were not evaluated against a
  specific threat model this session; noted as a future hardening
  candidate, not a requirement.
- Does not weaken any existing application-level security control
  (CORS allowlist, rate limiting, `JwtAuthGuard`/`RolesGuard`/
  `ActiveUserGuard`, webhook signature verification) — every one of
  those remains exactly as implemented; this document only describes
  the network layer around them.
