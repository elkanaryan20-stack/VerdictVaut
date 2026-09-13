# AWS Network Design — Phase 25

**Status: DESIGNED, NOT PROVISIONED.** A concrete VPC specification for
`docs/aws-production-architecture.md`'s target — no VPC, subnet,
security group, or route table exists for this project in any AWS
account. Region is an **EXAMPLE ONLY** placeholder (`us-east-1`, AZs
`us-east-1a`/`us-east-1b`) purely to make the subnet math concrete —
the real region is **REQUIRES HUMAN APPROVAL** (see
`docs/aws-production-architecture.md` §10).

## 1. VPC

| Attribute | Value |
|---|---|
| CIDR | `10.0.0.0/16` — EXAMPLE ONLY, chosen only to leave room for all subnet tiers below with growth headroom; must not collide with any VPN/peered network the real deployment ever needs to reach (unknown to this repository) |
| Availability Zones | 2 minimum (`us-east-1a`, `us-east-1b` — EXAMPLE ONLY), matching RDS Multi-AZ's own 2-AZ requirement and standard ALB best practice (an ALB requires subnets in 2+ AZs) |
| DNS support / hostnames | Enabled — required for RDS endpoint resolution and ECS service discovery if ever used |

## 2. Subnet tiers (per AZ — so ×2 for the 2-AZ example above)

| Tier | Example CIDR (AZ a / AZ b) | Contents | Internet route |
|---|---|---|---|
| Public | `10.0.0.0/24` / `10.0.1.0/24` | ALB elastic network interfaces, NAT gateway(s) | Route to Internet Gateway |
| Private — application | `10.0.10.0/24` / `10.0.11.0/24` | ECS Fargate tasks: `verdictvaut-web`, `verdictvaut-api`, `verdictvaut-worker` | Route to NAT gateway (outbound only) |
| Private — database (isolated) | `10.0.20.0/24` / `10.0.21.0/24` | RDS for PostgreSQL (Multi-AZ primary + standby) | **No internet route at all** — not even outbound |

**RDS must not be publicly accessible — satisfied by construction**:
the DB subnet tier has no route to an Internet Gateway or NAT gateway
in either direction, and (independently, defense-in-depth) the RDS
instance itself must be created with "publicly accessible" set to
`false` and no security-group rule ever grants a public CIDR access to
port 5432.

## 3. Internet Gateway

One per VPC, attached, referenced only by the public subnets' route
table. No private or database subnet route table references it.

## 4. NAT Gateway(s)

| Environment | NAT strategy | Rationale |
|---|---|---|
| Staging | 1 NAT gateway (single AZ) | Lower cost; staging does not need to survive a single-AZ NAT failure the way production does — an acceptable, documented tradeoff, not an oversight |
| Production | 1 NAT gateway per AZ (2 total in the example) | A single shared NAT gateway would make the *application* subnets' egress path a single point of failure across both AZs, undermining the Multi-AZ design elsewhere in this architecture — each AZ's private application subnet routes to its own AZ's NAT gateway |

Each private application-subnet route table has a `0.0.0.0/0` route to
its AZ's NAT gateway. Database subnet route tables have **no**
`0.0.0.0/0` route of any kind.

## 5. Security groups

| Security group | Inbound | Outbound |
|---|---|---|
| `alb-sg` | 443/tcp from `0.0.0.0/0` (and `::/0` if IPv6 enabled); 80/tcp from `0.0.0.0/0` (redirect listener only, never forwards to a target) | To `web-task-sg` (3000/tcp), `api-task-sg` (4000/tcp) |
| `web-task-sg` | 3000/tcp from `alb-sg` only | To `0.0.0.0/0` on 443/tcp (via NAT — reaching the API's public DNS and any other HTTPS dependency) |
| `api-task-sg` | 4000/tcp from `alb-sg` only | To `rds-sg` (5432/tcp), and 443/tcp to `0.0.0.0/0` via NAT (Fireblocks, Elliptic, Postmark, Secrets Manager if no VPC endpoint) |
| `worker-task-sg` | **No inbound rule of any kind** | To `rds-sg` (5432/tcp), and 443/tcp to `0.0.0.0/0` via NAT (blockchain RPC, Fireblocks) |
| `rds-sg` | 5432/tcp from `api-task-sg` and `worker-task-sg` only | None needed (isolated subnet, stateful SG return traffic only) |

**No security group in this design ever allows inbound from
`0.0.0.0/0` except `alb-sg`'s own 443/80 listeners.** No egress rule is
ever scoped to a bare IP address — every outbound destination is
reached by DNS/configured URL (unchanged application-level pattern,
`rpc-config.service.ts`).

## 6. Exact intended traffic relationships (as specified by this phase's brief)

```
ALB          → Web            (443 in, 3000 to web-task-sg, via alb-sg)
ALB          → API            (443 in, 4000 to api-task-sg, via alb-sg)
API          → RDS            (api-task-sg → rds-sg, 5432)
Worker       → RDS            (worker-task-sg → rds-sg, 5432)
API/Worker   → approved external HTTPS dependencies
               (blockchain RPC, Fireblocks, Elliptic, Postmark,
               Secrets Manager) — via NAT gateway, 443 only
```

**No other traffic relationship is designed.** Specifically not
designed: Web → RDS (the web service never holds a `DATABASE_URL`),
any inbound rule on `worker-task-sg`, any public IP assignment to any
ECS task (`assign_public_ip = false` on all three services — the ALB
is the only ingress path).

## 7. Route tables

| Route table | Associated subnets | Routes |
|---|---|---|
| Public | Public subnets (both AZs) | Local VPC route + `0.0.0.0/0` → Internet Gateway |
| Private-app-a | Application subnet, AZ a | Local VPC route + `0.0.0.0/0` → NAT gateway (AZ a) |
| Private-app-b | Application subnet, AZ b | Local VPC route + `0.0.0.0/0` → NAT gateway (AZ b, production) or NAT gateway (AZ a, staging's single-NAT design) |
| Private-db | Both database subnets | Local VPC route **only** — no default route of any kind |

## 8. VPC endpoints (optional hardening, not required for launch)

Interface VPC endpoints for Secrets Manager and CloudWatch Logs would
remove the API/worker's need to reach those services via the NAT
gateway/public AWS endpoints, reducing NAT data-transfer cost and
slightly narrowing the egress surface. **Not required** — the
NAT-gateway path already satisfies every functional and the stated
security requirement (RDS never public, worker never exposed); VPC
endpoints are a cost/hardening optimization for whoever operates this
in production to decide, not designed further here.

## 9. What this document does not do

- Does not create a VPC, subnet, route table, security group, NAT
  gateway, or Internet Gateway — no AWS account exists.
- Does not select the real region or real CIDR block — both require
  human approval and, for the CIDR, awareness of any other network
  this VPC might ever need to peer with (VPN, another AWS account),
  which this repository has no visibility into.
- Does not weaken the "RDS never public" requirement under any
  configuration variant described above (staging and production both
  keep the isolated DB-subnet-tier design; only the NAT redundancy
  differs between them, per §4).
