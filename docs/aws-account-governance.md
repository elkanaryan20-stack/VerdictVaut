# AWS Account Governance — Phase 26

**Status: DESIGNED, NOT PROVISIONED.** No AWS account, organization,
IAM Identity Center instance, or billing configuration exists for this
project. Every control below is a specification for the human operator
who creates and owns the real AWS account(s) — nothing here is
implemented through a live AWS API call, and nothing here can be,
since no account exists to call.

## 1. Account structure

| Control | Design | Status |
|---|---|---|
| Dedicated production account | A separate AWS account for production, not a "prod" set of resources inside a shared/personal account — the single strongest blast-radius control available (an IAM mistake, a leaked credential, or a runaway cost in staging cannot touch production if they are different accounts entirely) | **REQUIRES HUMAN APPROVAL** — account creation is a business action outside this repository's authority |
| Separate staging account/environment | **Recommended**: a genuinely separate AWS account for staging, mirroring the production/staging separation already designed in `infra/terraform/environments/{staging,production}` at the Terraform-state level. Where a second account is not practical (cost, org overhead for an early-stage project), the fallback is the isolation this repository's Terraform already provides — separate VPC, separate state, separate secrets, separate database, per `docs/aws-terraform-security-review.md` §1's confirmed findings — but a second account remains the stronger control | **RECOMMENDED — REQUIRES HUMAN APPROVAL** |
| AWS Organizations | If 2+ accounts are created, an AWS Organization (even a minimal one) centralizes billing and enables Service Control Policies (SCPs) — e.g. an SCP that makes it structurally impossible for the staging account's IAM roles to ever touch production, a stronger guarantee than IAM policy alone | DESIGNED, optional but recommended once 2+ accounts exist |

## 2. Root account protection

The root user of every AWS account created for this project must:

- Have MFA enabled (hardware security key strongly preferred over
  virtual/app-based MFA for the production account's root user — the
  root user has no IAM policy that can restrict it, so this is the
  single most consequential credential in the entire account).
- Never be used for daily operations — root sign-in should be a rare,
  logged, deliberate event (account recovery, closing the account, a
  handful of actions AWS restricts to root only, e.g. certain billing
  console changes).
- Have no access key created at all, ever, unless a specific AWS API
  action genuinely requires root (rare, and should be revoked
  immediately after use if ever created).
- Have its credentials (password + MFA device) stored in a
  break-glass process (§3), not in a password manager any single
  individual routinely uses for other work.

**No root credential is created, stored, or referenced anywhere in
this repository** — this phase does not (and could not) touch any real
AWS account.

## 3. Break-glass procedure (DESIGNED — to be adopted once an account exists)

A documented, rarely-used procedure for the scenario where normal
IAM-role-based access is unavailable (e.g. IAM Identity Center is
down, or every role capable of fixing a misconfiguration has itself
been misconfigured):

1. Root credentials are held in a physically/organizationally
   separated location from daily-use secrets (e.g. a sealed
   password-manager vault with access logged and requiring 2 people to
   open — the exact mechanism is an operational decision this
   repository doesn't make, only requires exist).
2. Using break-glass root access is itself an incident — it should
   trigger the same incident-response process as
   `docs/disaster-recovery-runbooks.md` runbook M (security-incident
   recovery), including a post-incident review of why normal access
   was unavailable.
3. Immediately after use, rotate whatever the break-glass event
   required (root password, MFA device re-registration if the device
   was itself compromised) and document what was done and why.

## 4. Human access — IAM Identity Center, not long-lived IAM users

- **No human should have a long-lived IAM access key.** Human access
  to the AWS Console/CLI should go through AWS IAM Identity Center
  (formerly AWS SSO) — short-lived, federated credentials, centrally
  revocable, with MFA enforced at the identity-provider level.
- **Role-based, least-privilege human access** — e.g. a
  `ReadOnlyAccess`-equivalent role for anyone who needs visibility but
  not change authority, a narrower "developer" role scoped to the
  specific services this project actually uses (ECS, RDS read,
  CloudWatch Logs read — not IAM, not billing), and a small,
  named-individual "admin" role for whoever actually applies Terraform
  changes. Exact role definitions are an operational decision for
  whoever staffs this project — not fixed here, since this repository
  has no visibility into team size/structure.
- **No root access for daily operations** — restated as its own
  explicit requirement per this phase's brief: every day-to-day action
  (deploying, debugging, reading logs) should be achievable through an
  IAM Identity Center role, never root.
- **The Terraform CI/CD deploy role** (`docs/aws-iam-and-secrets.md`
  §2.5) is a *machine* identity (GitHub Actions OIDC), entirely
  separate from human access design here — not duplicated.

## 5. CloudTrail

- **Enabled in every account, in every region**, logging management
  events (API calls that create/modify/delete resources) at minimum;
  data events (e.g. S3 object-level access, Secrets Manager
  `GetSecretValue` calls) are a stronger but costlier option worth
  enabling at least for the Secrets Manager secrets this project's
  Terraform creates, given how sensitive `GetSecretValue` access is
  here specifically.
- **Log file validation enabled** (CloudTrail's own integrity-checking
  feature) — detects tampering with the log files themselves.
- **Delivered to a dedicated, access-restricted S3 bucket** — ideally
  in a separate "logging" account if an AWS Organization is used, so
  that even an attacker with full admin access to the production
  account cannot delete the audit trail of how they got there.
- **Not configured by this phase** — no account exists.

## 6. Billing alerts, AWS Budgets, cost anomaly detection

- **AWS Budgets**: at minimum one budget per account (staging,
  production) with alert thresholds at, e.g., 50%/80%/100% of an
  agreed monthly ceiling — the exact ceiling is a business decision
  (`docs/aws-cost-governance.md` deliberately does not invent a number).
- **Cost Anomaly Detection**: AWS's built-in ML-based anomaly detector
  (free) should be enabled on both accounts — catches a runaway NAT
  gateway data-transfer bill or an accidentally-left-running resource
  far faster than a monthly budget threshold alone.
- **Billing alerts routed to a real, monitored destination** (email
  distribution list, Slack webhook, PagerDuty — not a single
  individual's personal inbox) — the destination is an operational
  decision, not fixed here.
- **Not configured by this phase.**

## 7. Service quotas

- Review default AWS service quotas relevant to this architecture
  before they become a real constraint: VPCs per region (default 5,
  usually not a factor here), Elastic IPs per region (this design uses
  1-2 for NAT gateways per environment — default quota of 5 is
  comfortable), RDS instances per account, Secrets Manager secrets per
  account (default quotas are high, unlikely to bind at this
  project's current scale).
- **Not requested/verified against a real account this phase** — no
  account exists to check quotas against; this is a pre-launch
  checklist item for whoever provisions the real account.

## 8. Tagging strategy

Already partially implemented in the Terraform skeleton
(`infra/terraform/environments/*/providers.tf`'s `default_tags` block
applies `Project = "verdictvaut"`, `Environment`, `ManagedBy =
"terraform"` to every resource in each provider configuration; every
individual resource additionally tags at least `Name` and
`Environment` — re-verified this session by reading every module's
`main.tf`). Recommended additions for a real account (not implemented,
since they don't change any resource's actual configuration and are a
low-risk future addition):

| Tag | Purpose |
|---|---|
| `CostCenter` | If/when cost needs to be attributed to a team or budget line |
| `Owner` | The individual/team accountable for a resource — useful once more than one person operates this |
| `DataClassification` | e.g. `financial` on the RDS instance and its secrets — helps a future automated compliance/audit tool (not built here) flag the highest-sensitivity resources first |

## 9. What this document does not do

- Does not create an AWS account, IAM Identity Center instance,
  CloudTrail trail, Budget, or any tag on a real resource.
- Does not choose a specific break-glass storage mechanism, human role
  taxonomy, or cost ceiling — each requires a decision this repository
  has no authority or visibility to make.
- Does not weaken any existing application-level security control.
