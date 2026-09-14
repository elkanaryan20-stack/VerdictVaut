# AWS Region Selection — Phase 26

**Status: no production region is selected by this document.**
Extends `docs/aws-production-architecture.md` §10 (which already
declined to silently choose one) with the full criteria this phase's
brief asks for, and one labeled recommendation for whoever owns this
decision to accept, override, or reject.

## 1. Criteria

### Data residency

Does VerdictVaut have, or will it have, users or regulatory
obligations tying data to a specific jurisdiction (e.g. EU users
implying data must stay in an EU region under GDPR-adjacent
reasoning; a specific US state's money-transmitter licensing regime;
a jurisdiction that outright restricts where financial records may be
stored)? **This repository has no visibility into VerdictVaut's actual
or intended user base or regulatory posture** — genuinely unknown
here, not omitted by oversight. This is very likely the single
highest-weight criterion, and the one this document is least equipped
to answer.

### Latency to users

Where are VerdictVaut's actual or expected users located? A
prediction-market trading platform benefits from low API latency for
order placement/matching, though this codebase's matching engine is
not so latency-sensitive that cross-region round-trips would break
correctness (no sub-millisecond requirement anywhere in the trading
logic, confirmed by re-reading the matching engine's own design in
prior phases — it is priority/time-ordered, not latency-arbitrage
sensitive). Still unknown to this repository: the real target user
geography.

### Latency to blockchain RPC providers

The worker's poll-based watcher design (`chain-adapters/retry.util.ts`'s
bounded exponential backoff) already tolerates ordinary network
latency — this is not a hard constraint. Most major RPC providers
(the ones this codebase's `.env.example` anticipates via
`BITCOIN_TESTNET_RPC_URL`/`ETHEREUM_SEPOLIA_RPC_URL`/etc.) run
globally-distributed, anycast-routed infrastructure rather than a
single regional endpoint, so "which AWS region is closest to the RPC
provider" is usually a minor factor — not independently verified
against any specific provider's current infrastructure this session,
since no specific mainnet RPC provider has been chosen (the current
config uses public testnet endpoints only).

### Custody-provider connectivity

Fireblocks (sandbox today, `sandbox-api.fireblocks.io`) — no specific
region-pinning requirement or dedicated-connectivity option was
verified against Fireblocks' own current documentation this session;
their API is reached over the public internet by the existing adapter
code, same reasoning as blockchain RPC above. If a future production
custody integration requires dedicated connectivity (e.g. AWS
PrivateLink, if Fireblocks or another provider offers it), that would
become a real regional constraint at that time — not evaluated here
since no production custody integration exists.

### Compliance-provider connectivity

Same reasoning as custody — Elliptic (sandbox today) is reached over
the public internet; no verified region-specific requirement.

### Availability-zone support

Any AWS region with **at least 2 Availability Zones** satisfies this
architecture's own requirement (`docs/aws-network-design.md` §1) — true
of every standard AWS region as of this session's general knowledge
(the handful of AWS Local Zones/Wavelength Zones are single-AZ by
design and are not candidates for this architecture regardless).

### Service availability

Every AWS service this architecture depends on — RDS for PostgreSQL,
ECS Fargate, Application Load Balancer, Secrets Manager, CloudWatch,
ACM, Route 53 — is available in every one of AWS's standard
(non-GovCloud, non-China) regions as of this session's general
knowledge. **Not independently re-verified against AWS's own
region-service table this specific session** — a real verification
step for whoever finalizes the choice, since AWS does occasionally
launch a new region with a reduced initial service set.

### Disaster-recovery region strategy

`docs/aws-disaster-recovery.md` §5 already treats a cross-region DR
strategy as a separate, larger decision layered on top of the primary
region — restated, not re-derived here: whichever primary region is
chosen, a plausible second region (same country/legal jurisdiction,
for data-residency consistency) should exist and be at least
mentally reserved, without that constraining today's primary-region
choice.

## 2. Recommendation

**RECOMMENDED — REQUIRES HUMAN APPROVAL: `us-east-1` (N. Virginia), as
a default absent a data-residency or user-geography constraint this
repository cannot see.**

Reasoning:

- It is AWS's largest, most mature region — broadest service
  availability, typically first to receive new features, deepest
  operational track record. Every service this architecture needs
  (§1) has been available there the longest.
- It is a reasonable, defensible default for a project with no
  currently-known data-residency constraint and no currently-known
  concentrated non-US user base.
- It is the same region used as the `EXAMPLE ONLY` illustration
  throughout `docs/aws-network-design.md` and the Terraform variable
  defaults (`us-east-1a`/`us-east-1b` in both
  `environments/*/terraform.tfvars.example`) — accepting this
  recommendation requires no rewriting of those examples, only
  removing their "EXAMPLE ONLY" caveat.

**This recommendation is overridden immediately by any of the
following, none of which this repository can evaluate on its own**:

- A real data-residency requirement (e.g. EU users under a
  jurisdiction requiring EU-region storage) — would point to
  `eu-west-1` (Ireland) or `eu-central-1` (Frankfurt) instead.
- A concentrated user base outside North America — would point to a
  region closer to that geography.
- An existing organizational AWS relationship, negotiated enterprise
  discount, or compliance certification already tied to a specific
  region.
- A specific custody/compliance vendor's own published
  regional-connectivity recommendation, once a real (non-sandbox)
  vendor relationship exists — not evaluated here since none does.

**No region is provisioned or configured by this document.** Every
`aws_region`/`availability_zones` Terraform variable remains without a
default (`docs/aws-terraform-security-review.md` §1, unchanged) —
accepting this recommendation means setting those variables in a real
`terraform.tfvars`, not editing any `.tf` file.

## 3. What this document does not do

- Does not select a region on the business owner's behalf — the
  recommendation above is exactly that, a recommendation, clearly
  labeled.
- Does not provision anything in any region.
- Does not verify AWS's current per-region service catalog against a
  live source this session — flagged as an open verification step.
