# Rollback Runbook — Phase 29

The single, concrete rollback procedure for a VerdictVaut production
deployment. Cross-references rather than duplicates
`docs/production-deployment-plan.md` §7 (the original rollback
decision table, Phase 24) and `docs/operations-runbook.md` §3 (Phase
16's own rollback summary) — both remain accurate; this document adds
the withdrawal/custody-safety and blockchain-watcher/reconciliation-
safety detail neither previously covered, and ties rollback to the
real Phase 28 tooling (`ecr-publish.yml`'s `image_tag` input,
`modules/ecs-service`'s deployment circuit breaker) that didn't exist
when those documents were written.

**No database migration can always be rolled back automatically.**
Stated once, plainly, here — restated wherever this document might
otherwise imply otherwise. Prisma migrations are forward-only; there is
no generated "down" migration. A schema rollback is either a new
forward migration that reverses the change, or a full database restore
(a disaster-recovery event, not a routine rollback) — never an
automated "undo."

## 1. Application rollback (no migration involved)

**The common case — most rollbacks are this.**

1. Identify the last known-good commit SHA (the immutable ECR tag that
   was serving traffic before the bad deploy).
2. Run `.github/workflows/ecr-publish.yml` with `image_tag` set to that
   SHA — this skips the build entirely (the image already exists,
   immutably tagged) and redeploys it unchanged via the same
   `register-task-definition` + `update-service` path a forward deploy
   uses. **This is the one-command rollback action** this phase's brief
   asked for.
3. The same `verify-deployment` job (Phase 29) that gates a forward
   deploy also gates a rollback — `production-smoke-test.js` must pass
   before the rollback is considered complete, not just "the ECS
   service update was accepted."
4. If the bad deploy is still mid-rollout when discovered:
   `modules/ecs-service`'s `deployment_circuit_breaker` (Phase 28,
   `enable = true, rollback = true`) may already be rolling ECS back to
   the previous task definition automatically — check
   `GET /admin/watchers` and the ECS console/`aws ecs describe-services`
   before manually triggering step 2, to avoid two rollbacks racing
   each other.

## 2. ECS task-definition rollback (infrastructure-level)

Distinct from §1 when the problem is the task definition's *shape*
(CPU/memory/environment/secrets/logging — Terraform-managed), not the
image tag:

1. Identify the previous task-definition revision:
   `aws ecs list-task-definitions --family-prefix verdictvaut-<environment>-<service> --sort DESC`.
2. If the change came from a `terraform apply` (e.g. a bad environment
   variable): revert the offending Terraform change in a new commit,
   run `terraform-deploy.yml` for a fresh `plan` + human-approved
   `apply` — **never hand-edit a task definition via the AWS
   Console/CLI outside Terraform**, or the next real `terraform apply`
   will silently revert your manual fix (Terraform's own drift-
   correction behavior, not a bug).
3. If the change came from `ecr-publish.yml`'s own
   `register-task-definition` step (e.g. a bad image tag baked into a
   revision): §1's `image_tag` rollback already produces a new,
   correct revision — no separate action needed.

## 3. Image rollback

Already covered structurally: ECR's `modules/ecr` repositories are
`image_tag_mutability = "IMMUTABLE"` — every commit-SHA tag, once
pushed, is permanently available and can never have been silently
replaced underneath the same tag. §1's `image_tag` input IS the image
rollback mechanism; there is no separate "restore an image" step
because nothing about a previously-pushed image ever needs restoring —
it was never at risk of being lost or altered.

## 4. Database migration considerations

Restated from `docs/production-deployment-plan.md` §7, with the
explicit "no automatic rollback" framing this phase's brief requires:

| Scenario | Action |
|---|---|
| Bad migration, caught before real damage, schema-only | Write and apply a NEW forward migration reversing the change (`check-migration-safety.js`, Phase 29, still applies to this new migration like any other — an unacknowledged destructive statement in the REVERSAL migration fails CI too, which is correct: a careless rollback migration is exactly as dangerous as a careless forward one). |
| Bad migration, data already lost/corrupted | This is a disaster-recovery event, not a routine rollback — stop here, go to `docs/disaster-recovery-runbooks.md` runbook L (migration failure) and runbook F (full restore). |
| Migration itself fails mid-apply | Do not force-retry blindly — runbook L covers the investigation sequence; `_prisma_migrations` records partial-apply state for a human to inspect first. |

**Never** attempt a scripted "undo the last migration" — no tooling in
this repository does this, and none should be added; this is a
deliberate, standing design decision (`docs/production-deployment-plan.md`
§7), not an oversight this phase should close.

## 5. Configuration rollback

- **Terraform-managed configuration** (env vars baked into a task
  definition, security group rules, ALB routing): revert the offending
  commit, re-run `terraform-deploy.yml`'s plan/apply — same as §2 step
  2.
- **Secrets Manager values** (JWT secrets, provider tokens): Terraform
  never sets these (`modules/secrets`' own design — object only, never
  a value). A bad secret rotation is reverted by setting the previous
  value back via the AWS Console/CLI directly, then redeploying any
  process that needs to pick it up (there is no live-reload of an
  injected secret — restated from `docs/operations-runbook.md` §10).
  Rotating a secret back also means every session/token signed with
  the "bad" value between rotation and rollback is now invalid —
  expect a forced re-login wave, same caveat as any JWT secret change.

## 6. Failed deployment handling

1. `verify-deployment` (the `ecr-publish.yml` job, Phase 29) failing is
   the authoritative "this deployment is not healthy" signal — do not
   manually override or re-run it hoping for a different result without
   first understanding why it failed (read the specific check(s) that
   failed in its output, not just the overall red X).
2. If ECS's own circuit breaker already rolled back (§1 step 4), the
   service may already be back on the previous revision by the time a
   human looks — confirm via `aws ecs describe-services` /
   `GET /admin/watchers` before assuming a rollback is still needed.
3. If the deployment is stuck (neither healthy nor rolled back — e.g.
   the circuit breaker is disabled for a specific service via
   `enable_deployment_circuit_breaker = false`, an explicit,
   documented-only-for-a-stated-reason opt-out): manually trigger §1's
   `image_tag` rollback rather than waiting.

## 7. Withdrawal/custody safety during rollback

**A rollback must never be treated as a reason to pause, skip, or
rush the existing withdrawal safety controls.**

- A withdrawal already `BROADCAST`/`CONFIRMING` is tracked by on-chain
  confirmation, not by which application version is currently
  deployed — a rollback (application or infrastructure) does not
  affect its outcome. Do not attempt to "cancel" or manually intervene
  in an in-flight broadcast because a rollback is happening elsewhere.
- A withdrawal in `EXECUTION_AMBIGUOUS` state (the outcome genuinely
  unknown — see `docs/operations-runbook.md` §8) must still be
  resolved through `POST /admin/withdrawals/:id/resolve-ambiguous-execution`
  with real, independently-verified evidence, exactly as if no
  rollback were in progress. **Never resolve an ambiguous withdrawal
  "to clear the queue" before a rollback** — the ambiguity is about
  the real world (did the provider actually broadcast), not about
  which application version is running, and rolling back changes
  neither.
- If the ROLLED-BACK version had a genuine withdrawal-processing bug
  (the reason for the rollback): review `GET /admin/withdrawals`
  filtered to the time window the bad version was live, specifically
  for any withdrawal that transitioned through an unexpected state —
  do not assume "we rolled back" means "any damage stopped
  retroactively"; a bad version could have created a bad state that
  persists after rollback and needs its own remediation.
- The custody provider boundary (`ProductionCustodyExecutor` throwing
  unconditionally, `WithdrawalExecutorFactory`'s environment-matching
  refusal) is application code, versioned like everything else — a
  rollback to an OLDER version cannot accidentally enable production
  custody if the current version has it disabled (there is no
  "enable" path at all, only "throw"), but a rollback to a version
  that predates a safety fix could reintroduce a fixed bug. Check
  `git log` for the specific commits between the rolled-back-FROM and
  rolled-back-TO versions before rolling back past a security-relevant
  fix, not just for feature changes.

## 8. Blockchain watcher/reconciliation safety during rollback

- The deposit watcher's per-asset-network CAS lease
  (`BlockchainWatchCursor`) and the withdrawal watcher's status-guarded
  updates make a brief overlap between old and new worker versions —
  or a gap while the worker is between versions — safe by design
  (idempotency, not timing, is what prevents duplicate/lost
  processing; re-verified unchanged this phase). A worker rollback
  needs no special sequencing beyond §1's own health-check gate.
- **After any rollback that followed a suspected watcher/reconciliation
  bug** (not just any rollback): run the independent reconciliation
  rescan (`POST /admin/reconciliation/:assetNetworkId/independent-rescan`)
  against every active asset/network before trusting the rolled-back
  version's own cursor state — the bad version may have advanced a
  cursor past activity it mishandled; the rescan is independent of
  whatever the cursor currently claims (`IndependentReconciliationService`'s
  entire design point, unchanged).
- A rollback is never itself a reason to acknowledge or resolve an
  OPEN `ReconciliationDiscrepancy` — close it only once the underlying
  cause is actually understood and fixed, exactly as
  `docs/operations-runbook.md` §7 already requires outside of a
  rollback context.

## 9. Incident escalation

Same process as every other incident — `docs/operations-runbook.md`
§11, not re-derived here. A rollback triggered by a real fund-safety
issue (an incorrect balance, a wrongly-executed withdrawal, a security
incident) is a Sev1 by that document's own classification regardless
of whether the rollback itself succeeds cleanly — completing the
rollback does not close the incident; the postmortem requirement
(§11 item 3) still applies.

## 10. What this document does not do

- Does not provide a scripted/automated database-rollback tool — none
  exists, and none should, per §4's own restated principle.
- Does not claim any of the above has been exercised against a real
  production deployment — no AWS account exists; every mechanism cited
  (circuit breaker, `image_tag` rollback, `verify-deployment` gate) is
  DESIGNED and code-reviewed, not live-tested end-to-end.
- Does not weaken any custody/compliance/withdrawal safety control —
  §7/§8 above are additional guidance layered on top of the existing,
  unchanged controls, never a substitute for them.
