# AWS Cost Governance — Phase 26

**Status: DESIGNED, NOT PROVISIONED.** No AWS cost has been incurred —
no resource exists. This document is a concrete cost-control checklist
for the architecture in `docs/aws-production-architecture.md`, plus
the highest-cost-risk components flagged as this phase's brief
requires. **No exact price is invented anywhere in this document** —
AWS pricing changes over time and varies by region/commitment level; a
real quote must come from AWS's own current pricing pages or the AWS
Pricing Calculator at the time of provisioning, not guessed here.

## 1. Highest cost-risk components — flagged explicitly per this phase's brief

### NAT Gateways — HIGH cost-risk

NAT gateways bill on **two dimensions**: an hourly charge per gateway
(regardless of traffic) and a per-GB **data processing** charge for
everything that flows through them. This architecture's design
(`docs/aws-network-design.md` §4) runs 2 NAT gateways in production
(one per AZ, for HA) and 1 in staging — each one an hourly charge
whether or not any traffic flows. The data-processing charge is the
less predictable risk: every outbound call the API/worker make to
Fireblocks, Elliptic, Postmark, and blockchain RPC endpoints (§`docs/aws-network-design.md`
§3) passes through a NAT gateway, and a chatty polling loop, a
misconfigured retry storm, or a large response payload from an RPC
call could all drive this cost up in a way that's invisible until the
bill arrives. **This is the single most likely "surprise" line item in
this architecture** — flagged explicitly per this phase's brief.
Mitigation: VPC interface endpoints for Secrets Manager/CloudWatch
(already noted as optional in `docs/aws-network-design.md` §8) would
remove some NAT traffic; watching data-processing metrics via Cost
Anomaly Detection (`docs/aws-account-governance.md` §6) is the
practical safety net.

### RDS sizing — HIGH cost-risk

RDS is billed by instance class (hourly), storage (GB-month, plus
IOPS if provisioned-IOPS storage is ever chosen instead of `gp3`),
Multi-AZ (roughly doubles the compute cost, since it runs a full
synchronous standby), and backup storage beyond the free
allowance tied to allocated storage. **No load test has ever been run
against this schema at any scale** (`docs/aws-disaster-recovery.md`
§1, unchanged) — `infra/terraform/environments/*/variables.tf`
deliberately leaves `db_instance_class` with no default for exactly
this reason: guessing an instance size without real load data risks
either a production incident (undersized) or ongoing wasted spend
(oversized, "just to be safe"). **Flagged explicitly per this phase's
brief** as requiring real attention before provisioning — start from
the smallest instance class that plausibly handles expected launch
traffic, monitor actual CPU/memory/connection utilization via
Performance Insights (already enabled by default in the Terraform
module), and resize based on real data rather than a guess.

## 2. Per-service cost checklist

| Service | What drives cost | Cost-control checklist |
|---|---|---|
| ECS Fargate | vCPU-hours + memory-GB-hours per running task, across all replicas | Right-size `cpu`/`memory` per service (current Terraform starting values — 256/512 for web+worker, 512/1024 for API — are unverified-by-load guesses, `docs/aws-deployment-runbook.md` §1, not a cost-optimized measurement); keep worker at desired-count 1 (already the design — more replicas cost more without adding useful throughput at current scale, `docs/production-deployment-plan.md` §5); avoid over-provisioning `desired_count` on web/API beyond real traffic needs |
| RDS | See §1 above | Start small, measure, resize; `max_allocated_storage_gb` (currently defaulted to 100GB in the Terraform module) caps storage autoscaling — review this cap periodically so it doesn't either block real growth or hide a runaway-storage bug behind "it just keeps autoscaling" |
| NAT Gateway | See §1 above | Single shared NAT in staging (already the design — `docs/aws-network-design.md` §4); consider VPC endpoints for Secrets Manager/CloudWatch if NAT data-processing cost becomes material |
| ALB | Hourly charge + LCU (load-balancer-capacity-unit) usage, driven by connection count/bandwidth/rule evaluations | Low risk at this project's expected scale — one ALB per environment, a handful of listener rules; not a component likely to dominate the bill |
| ECR | Storage (GB-month) per stored image layer | Immutable SHA tagging (`docs/aws-deployment-runbook.md` §3) means old images accumulate — a lifecycle policy expiring untagged images quickly and capping tagged-image retention (e.g. most recent 50) bounds this; not yet created (no repository exists) |
| CloudWatch | Log ingestion (GB) + storage (GB-month) + custom metrics/alarms if added later | `log_retention_days` (Terraform default 30) bounds storage growth; ingestion volume scales with how verbose application logging is — this codebase's `JsonLoggerService` already logs one structured JSON line per request/event, not more, so this is a moderate, fairly predictable cost, not a top risk |
| Secrets Manager | Per-secret monthly charge + per-10k-API-calls charge | Small, fixed number of secrets per environment (3 in production today, 6 in staging — `docs/aws-iam-and-secrets.md` §3); low risk unless something starts calling `GetSecretValue` in a tight loop (ECS only reads it once per task start, not per-request — confirmed by design, not a runtime risk) |
| S3 | Not currently used by any Terraform resource in this design (no ALB access-log bucket, no backup off-site copy created — both optional, §`docs/aws-production-architecture.md` §9) | Zero cost today by construction; becomes a real line item only if/when either optional feature is added |
| Data transfer | Cross-AZ transfer (API↔RDS, ALB↔tasks across AZs), internet egress from NAT | Cross-AZ transfer is a real but usually modest cost at this project's scale; internet egress overlaps with the NAT gateway risk in §1 — not double-counted as a separate top risk, but worth watching via the same Cost Anomaly Detection mechanism |
| Backup storage (RDS automated backups, beyond the free allowance) | GB-month of backup storage beyond what's included free (an amount tied to allocated storage — exact free-tier math not invented here, verify current AWS documentation) | `backup_retention_days` (Terraform default 7) directly controls this; the proposed Phase 22 RPO target doesn't require a specific retention beyond what PITR needs, so no artificially long retention is set by default |
| Route 53 | Per-hosted-zone monthly charge + per-query charge (typically low) | Only incurred once a real domain/hosted zone is created — not created by this phase (`docs/aws-network-design.md`/`docs/aws-deployment-runbook.md` — no domain chosen) |
| ACM | **Free** for certificates used with integrated services (ALB, CloudFront, etc.) — not a cost-risk line item at all | No action needed |

## 3. What's provider-managed vs. what VerdictVaut operates vs. third-party vendors

Per this phase's brief §14 phrasing carried over from Phase 25's own
distinction (`docs/production-infrastructure-decision.md` §9's
service-mapping table, not duplicated here):

| Category | Examples | Cost implication |
|---|---|---|
| AWS-managed (pay for the managed service, not the underlying ops labor) | RDS (patching/failover automation included), Fargate (no EC2 fleet to patch/right-size at the host level), ACM (certificate issuance/renewal automation, free), Secrets Manager | Generally higher per-unit cost than self-hosting the equivalent, in exchange for materially lower operational burden — a deliberate, standard tradeoff, not re-litigated here |
| VerdictVaut-operated (application-level cost, not infra) | The application code itself, its CI pipeline, its test suites | No direct AWS cost — GitHub Actions minutes are a separate (non-AWS) cost line this document doesn't cover |
| Third-party vendors, already integrated or planned (non-AWS cost) | Fireblocks (custody, sandbox today), Elliptic (compliance, sandbox today), Postmark (email) | Entirely outside AWS billing — each has its own pricing model this document does not estimate; production use of any of the three remains structurally blocked regardless (`docs/aws-production-architecture.md` §11/§12) |

## 4. Cost governance checklist (for whoever provisions this)

- [ ] AWS Budgets configured per account/environment with alert
      thresholds (`docs/aws-account-governance.md` §6) — **NOT DONE**
- [ ] Cost Anomaly Detection enabled — **NOT DONE**
- [ ] `db_instance_class` chosen from real (even rough) load
      expectations, not a guess copy-pasted from an example — **NOT
      DONE**, no value is set anywhere in committed Terraform
- [ ] ECR lifecycle policy created once the first repository exists —
      **NOT DONE**, no repository exists
- [ ] NAT gateway data-processing cost reviewed after the first real
      week of traffic (staging or production) — **cannot be done**,
      nothing is provisioned
- [ ] `log_retention_days`/`backup_retention_days` reviewed against
      actual compliance/operational needs rather than left at their
      illustrative defaults — **NOT DONE**

## 5. What this document does not do

- Does not invent a specific dollar figure for any AWS service.
- Does not provision anything or enable any billing/cost feature
  against a real account.
- Does not recommend a specific `db_instance_class` or `cpu`/`memory`
  value beyond what `infra/terraform`'s own variables already require
  as explicit, non-defaulted input.
