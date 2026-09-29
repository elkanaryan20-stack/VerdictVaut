# VerdictVaut documentation index

Documents accumulated over 41 phases; many are phase-dated snapshots. Where
two documents disagree, **the newer phase wins**, and the source code is
the final authority. Labels:

- **LOCAL** — verifiable on a developer machine or in CI with no cloud account (tests, drills, simulations).
- **PROD-ONLY** — describes AWS/provider state that does not exist yet. Nothing in these has been provisioned or verified; treat every procedure as a plan.
- **REFERENCE** — design rationale or decisions.

## Start here

| Document | Label | Purpose |
|---|---|---|
| [production-cutover-gates.md](production-cutover-gates.md) | PROD-ONLY | **Current readiness status**: which gates PASS or are BLOCKED, and exactly what unblocks each |
| [phase-41-decisions.md](phase-41-decisions.md) | REFERENCE | Open business decisions (B), technical decisions taken (A), chain verification labels |
| [release-candidate-simulation.md](release-candidate-simulation.md) | LOCAL | `npm run rc:simulate -w apps/api`: full-stack clean-room RC run |
| [operations-runbook.md](operations-runbook.md) | LOCAL + PROD-ONLY | Day-to-day and incident procedures (§11–17: withdrawals, reconciliation, recovery) |

## Verification you can run locally

| Document | Label | Command |
|---|---|---|
| [release-candidate-simulation.md](release-candidate-simulation.md) | LOCAL | `npm run rc:simulate -w apps/api -- --runs 2` |
| [performance-and-capacity.md](performance-and-capacity.md) | LOCAL | `npm run perf -w apps/api` |
| [database-backup-recovery.md](database-backup-recovery.md) | LOCAL | `npm run backup:drill -w apps/api` |
| [security-and-operational-validation.md](security-and-operational-validation.md) | LOCAL | Security suite and dependency reachability |
| [production-readiness-checklist.md](production-readiness-checklist.md) | LOCAL | `npm run check:production-readiness -w apps/api` (external gates report BLOCKED by design) |

CI: `.github/workflows/ci.yml` runs on every push. `.github/workflows/release-candidate.yml` is manual-only (RC, drill, perf); neither touches AWS.

## Operations and recovery

| Document | Label |
|---|---|
| [operations-runbook.md](operations-runbook.md) | LOCAL + PROD-ONLY |
| [disaster-recovery-runbooks.md](disaster-recovery-runbooks.md) | PROD-ONLY |
| [rollback-runbook.md](rollback-runbook.md) | PROD-ONLY (staging rehearsal not yet run) |
| [observability-and-alerting.md](observability-and-alerting.md) | REFERENCE: metrics exist in code; **no alarm is provisioned** |

## Providers and integrations

| Document | Label |
|---|---|
| [provider-integration.md](provider-integration.md) | REFERENCE (custody/compliance adapters; production custody and compliance are NOT implemented) |
| [fireblocks-sandbox-smoke-test.md](fireblocks-sandbox-smoke-test.md) | PROD-ONLY (needs sandbox credentials) |
| [email-delivery.md](email-delivery.md) | PROD-ONLY (needs a Postmark token and a verified domain) |

## Infrastructure (AWS — nothing provisioned)

All PROD-ONLY:

- [aws-production-architecture.md](aws-production-architecture.md), [aws-network-design.md](aws-network-design.md), [aws-iam-and-secrets.md](aws-iam-and-secrets.md)
- [aws-deployment-runbook.md](aws-deployment-runbook.md), [aws-disaster-recovery.md](aws-disaster-recovery.md), [aws-production-change-control.md](aws-production-change-control.md)
- [aws-account-governance.md](aws-account-governance.md), [aws-cost-governance.md](aws-cost-governance.md), [aws-region-selection.md](aws-region-selection.md)
- [aws-terraform-security-review.md](aws-terraform-security-review.md), [aws-phase28-deployment-readiness.md](aws-phase28-deployment-readiness.md)

## Historical design records (superseded in detail by later phases)

All REFERENCE:

- [deployment-architecture.md](deployment-architecture.md) (P16), [production-database-requirements.md](production-database-requirements.md) (P16)
- [staging-deployment-validation.md](staging-deployment-validation.md) (P18), [production-database-readiness.md](production-database-readiness.md) (P22)
- [production-infrastructure-decision.md](production-infrastructure-decision.md) (P23/24), [production-deployment-plan.md](production-deployment-plan.md) (P24), [production-network-security.md](production-network-security.md) (P24), [production-secret-management.md](production-secret-management.md) (P24)
