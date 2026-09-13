# Disaster Recovery Runbooks — Phase 22

Operator-facing runbooks for the database-recovery scenarios the Phase
22 brief lists (A–M). Where a scenario is already covered by
`docs/operations-runbook.md` (Phase 16), this document cross-references
that section rather than duplicating it, and adds the runbooks that
didn't exist before this phase (corruption, accidental deletion,
regional disaster, failover, migration failure, security incident).

Every runbook states: prerequisites, who is authorized, the actual
actions, safety checks, validation, escalation, and what must NOT be
done. **No fictional provider-specific command is included anywhere
below** — where the real command depends on a managed provider that
hasn't been chosen (`docs/production-database-requirements.md` §5),
that is stated as a `<PROVIDER-SPECIFIC — not yet chosen>` placeholder,
never invented.

## A. Routine backup monitoring

**Prerequisites**: `infra/backup.sh` running on some cadence (§11 of
`docs/production-database-readiness.md` — no scheduler is built into
this repository; a human or external cron/managed-job must invoke it).

**Authorization**: any operator with read access to
`infra/backups/backup-metadata.jsonl` (or whatever the chosen provider's
own backup-status API/console reports).

**Actions**:
1. Confirm a new line was appended to `backup-metadata.jsonl` within the
   expected cadence window.
2. Confirm its `"status"` is `"success"`, not `"failed"`.
3. `docs/observability-and-alerting.md` alert #7 defines the concrete
   signal — this is currently a **local file**, not wired into
   `MetricsService`; an external process (log-shipping agent, cron
   check) is required to actually alert a human on it.

**Safety checks**: this is read-only monitoring — nothing here mutates
any database or backup file.

**Validation**: the presence of a recent `"status":"success"` line.

**Escalation**: no new line within the expected window, or any
`"status":"failed"` line → escalate to runbook B.

**Do NOT**: assume "no alert fired" means "the backup succeeded" if no
alerting is actually wired up yet (§9 of the readiness document — this
remains a real, open gap until an external sink is connected).

## B. Failed backup response

**Prerequisites**: a `"status":"failed"` line in `backup-metadata.jsonl`,
or a manual `infra/backup.sh` run that exited non-zero.

**Authorization**: any operator with access to the database host/
container; escalate to whoever owns the production database if this
recurs.

**Actions**:
1. Re-run `infra/backup.sh` manually and read its stderr output — it
   fails loudly (never silently) on a truncated/empty dump.
2. Check disk space on the backup destination — the single most common
   real-world cause of a failed/truncated dump.
3. Check that the target container/instance is actually reachable and
   not itself in a degraded state (if it is, this is now runbook C or H,
   not a backup-tooling problem).
4. Once the underlying cause is fixed, re-run the backup and confirm a
   `"status":"success"` line is appended.

**Safety checks**: none of the above touches the live database's data —
only the backup process itself.

**Validation**: a successful subsequent backup run, with its checksum
file present and its size sane (`infra/backup.sh`'s own >1KB sanity
check).

**Escalation**: two or more consecutive failures, or any failure whose
cause is unclear after step 1–3 → Sev2 per
`docs/operations-runbook.md` §11, escalate to Sev1 if it turns out the
underlying database itself is degraded.

**Do NOT**: silently retry indefinitely without investigating the cause,
or treat "the backup script exited 0" as proof the backup is actually
restorable — periodically verify with an actual restore (runbook F /
the drill in `docs/production-database-readiness.md` §5).

## C. Database corruption response

**Prerequisites**: evidence of corruption — Postgres logging page
checksum failures, unexplained query errors on previously-working
tables, or `financial-integrity-checks.js` reporting a violation with no
known application-level cause.

**Authorization**: SUPER_ADMIN-level operator; do not act alone on
anything that will touch balances — same "second person verifies before
a financial-control action is taken" principle
`docs/operations-runbook.md` §11 already establishes for incident
response generally.

**Actions**:
1. **Stop application writes immediately** if the corrupted instance is
   still reachable (scale the API/worker to zero) — corruption can
   compound under continued writes.
2. **Do not attempt to "repair in place"** with ad-hoc SQL — this can
   turn a recoverable corruption into an unrecoverable one.
3. Preserve the current (corrupted) state before touching anything —
   take a `pg_dump`/filesystem snapshot of it even though it's known-bad
   (you cannot un-delete evidence you overwrote).
4. Restore from the most recent known-good backup (runbook F).
5. Run `financial-integrity-checks.js` against the restored instance —
   a real failure here (not just "the server started") is what proves
   the restored copy is actually usable.
6. Run `IndependentReconciliationService`'s rescan against every active
   asset/network before resuming trading/withdrawal processing (same
   requirement as every restore — `docs/database-backup-recovery.md`
   §5's explicit warning).

**Safety checks**: never resume application traffic against a
suspected-corrupted instance "to see if it's fine" — verify via the
integrity checks first, every time.

**Validation**: `financial-integrity-checks.js` all-pass, plus a clean
independent reconciliation rescan.

**Escalation**: Sev1 immediately (`docs/operations-runbook.md` §11) —
corruption is a fund-safety-adjacent event by default until proven
otherwise.

**Do NOT**: run `prisma migrate reset`, `DROP`/`TRUNCATE` any table, or
any other destructive command "to clear the corruption" — that is data
loss, not a fix.

## D. Accidental data deletion

**Prerequisites**: a confirmed accidental `DELETE`/`TRUNCATE`/wrong-
target migration that removed real rows.

**Authorization**: SUPER_ADMIN-level operator, same two-person
verification principle as C.

**Actions**:
1. **Stop writes immediately** if the affected instance is still live —
   every second of continued operation risks the deleted rows' storage
   being reused (making even an advanced forensic recovery attempt less
   likely to succeed).
2. Determine the exact deletion time as precisely as possible (audit
   logs — `AuditLogService`'s existing, queryable trail — are the first
   place to check for what ran and when).
3. If WAL archiving/PITR exists (it does not today — see the readiness
   document §2): restore to a point immediately BEFORE the deletion —
   see runbook E.
4. If only periodic backups exist (today's actual state): restore the
   most recent backup taken BEFORE the deletion (runbook F) — anything
   written between that backup and the deletion is lost by definition;
   this is exactly what an RPO target (readiness document §2) is meant
   to bound, and today's RPO is effectively unbounded because no
   scheduled backup cadence exists.
5. Run the same post-restore validation as runbook C (steps 5–6).

**Safety checks**: never attempt to "undo" the deletion by re-inserting
reconstructed rows from memory/logs into the live database — that is
fabricating financial data, exactly what this phase's own instructions
forbid; the only legitimate path is restoring from a real backup.

**Validation**: same as runbook C.

**Escalation**: Sev1 (`docs/operations-runbook.md` §11) — an accidental
deletion of financial data is always fund-safety-adjacent.

**Do NOT**: fabricate replacement data, or treat a partial/best-effort
manual reconstruction as equivalent to a real restore.

## E. Point-in-time recovery

**Status: NOT APPLICABLE TODAY** — PITR requires WAL archiving, which
is not configured anywhere in this repository
(`docs/database-backup-recovery.md` §3, unchanged). This runbook
documents the PROCEDURE for whichever production setup eventually
implements it — it does not describe something currently executable.

**Prerequisites** (once implemented): a continuous WAL archive
(`pgBackRest`/`WAL-G`/a managed provider's built-in PITR), and a target
timestamp to recover to.

**Authorization**: SUPER_ADMIN-level operator, two-person verification.

**Actions** (generic — the real command is provider-specific and not
yet chosen):
1. Identify the exact target timestamp (immediately before the
   incident).
2. `<PROVIDER-SPECIFIC — not yet chosen: e.g. a managed provider's own
   "restore to point in time" console/API action, or pgBackRest's
   `--type=time --target="..."` restore>` — into a NEW instance, never
   over the live one (same non-negotiable property `infra/restore.sh`
   already enforces for logical backups).
3. Verify migration state (`npx prisma migrate status`) and run the same
   post-restore validation as runbook C.

**Safety checks**: same "restore into new, never overwrite live" rule
as every other restore path in this document.

**Validation**: same as runbook C, plus confirming the restored data's
latest timestamp genuinely matches the intended target point.

**Escalation**: Sev1.

**Do NOT**: claim PITR capability exists or was exercised until WAL
archiving is actually configured and this procedure has actually been
run for real against it.

## F. Full database restore

**Status: IMPLEMENTED IN REPOSITORY, drilled this session** — see
`docs/database-backup-recovery.md` §5 (the full procedure) and §6 (the
Phase 12A drill) plus `docs/production-database-readiness.md` §5 (this
phase's broadened drill, 22/22 checks passed).

**Prerequisites**: a verified-good backup file (checksum matches, see
`infra/restore.sh`'s new verification step).

**Authorization**: any operator for a drill/non-production restore;
SUPER_ADMIN-level for a real incident restore.

**Actions**: `infra/restore.sh <dump-file> [target_db_name]` — restores
into a NEW database (refuses if `target_db_name` matches the configured
active database — Phase 22 addition), then follow
`docs/database-backup-recovery.md` §5's steps 6–11 (verify migrations,
verify ledger/deposit/withdrawal/reconciliation state, restart the
application, re-run integrity checks) before resuming traffic.

**Safety checks**: checksum verification (new this phase), never-
overwrite-live (pre-existing + the new name-collision refusal).

**Validation**: `npx prisma migrate status` clean, `financial-integrity-
checks.js` all-pass, independent reconciliation rescan clean.

**Escalation**: Sev1 if this is a real incident restore, not a drill.

**Do NOT**: promote a restored database to serve real traffic before
integrity checks and the reconciliation rescan both pass.

## G. Regional disaster

**Status: NOT APPLICABLE TODAY** — this application has never been
deployed to more than one region, and no cross-region replica/DR site
exists (`docs/production-database-readiness.md` §10). Documented for
whenever a real production deployment adopts one.

**Prerequisites** (once implemented): a cross-region replica or a
documented "restore the latest backup into a fresh instance in another
region" procedure, plus DNS/connection-string cutover capability.

**Authorization**: highest-severity incident — whoever holds overall
incident-command authority for the organization, not a single engineer
acting alone.

**Actions** (generic):
1. Confirm the primary region is genuinely unavailable (not just one
   instance) via the provider's own status page and independent
   external monitoring.
2. `<PROVIDER-SPECIFIC — not yet chosen: promote a cross-region replica,
   or restore the latest backup into a new instance in a surviving
   region>`.
3. Update `DATABASE_URL` across every API/worker replica to the new
   region's instance — this is a coordinated redeploy
   (`docs/operations-runbook.md` §10's "Database credentials" rotation
   note already documents that there is no live-reload of
   `DATABASE_URL` mid-process).
4. Run the same post-restore validation as runbook C, at production
   scale — expect this to take materially longer than the drill in §5.

**Safety checks**: verify the failover target actually has current(-
enough) data before cutting over — a regional DR restore is exactly the
scenario where the real, business-approved RPO target
(`docs/production-database-readiness.md` §2) determines how much data
loss is "acceptable" versus "an incident on its own."

**Validation**: same as runbook C, plus confirming every dependent
process (API, worker) is actually pointed at the new instance and
serving traffic correctly.

**Escalation**: this IS the escalation — Sev1, highest priority,
company-wide incident command.

**Do NOT**: attempt a regional failover without first confirming the
target region's data currency — cutting over to a stale replica can
silently re-introduce exactly the kind of data-loss incident this
runbook exists to prevent.

## H. Primary database failure

**Status: partially covered** — see `docs/operations-runbook.md` §9
("Database outage") for the day-to-day degraded-connectivity case. This
section covers the escalation specifically for the primary INSTANCE
itself failing outright (not just transient unreachability).

**Prerequisites**: confirmed instance failure (not recoverable by a
simple restart/reconnect).

**Authorization**: SUPER_ADMIN-level, Sev1.

**Actions**:
1. Confirm via `GET /health/ready` (503) and independent verification
   (the provider's own console/status, or direct connection attempt)
   that this is a genuine instance failure, not a network blip.
2. If a managed provider's automated failover exists and is configured
   (not the case in this repository today — no provider is chosen):
   allow it to complete, then verify via `GET /health/ready` recovering
   to 200 with no manual DB action needed. Expect any transaction that
   was in flight during the failover window to have failed outright —
   `docs/production-database-readiness.md` §10 documents this as a real,
   known gap (`SerializableTransactionRunner` does not retry connection-
   level failures, only serialization conflicts).
3. If no automated failover exists (today's actual state): this is now
   a full restore event — follow runbook F against the most recent
   backup, onto a freshly-provisioned replacement instance.
4. Point every API/worker replica's `DATABASE_URL` at the replacement
   instance and redeploy.
5. Run the same post-restore validation as runbook C.

**Safety checks**: same as runbook F.

**Validation**: same as runbook F, plus confirming every replica is
reconnected.

**Escalation**: Sev1 immediately.

**Do NOT**: assume a "successful" automated failover means no data was
lost — verify with the integrity checks regardless.

## I. Failover

**Status: NOT APPLICABLE TODAY** — no HA/failover infrastructure exists
(`docs/production-database-readiness.md` §10). This is the drill
procedure for whenever a managed-HA provider is chosen and configured.

**Prerequisites**: a managed provider's automated (or manually-
triggerable) failover mechanism, configured and tested at least once
outside of a real incident.

**Authorization**: SUPER_ADMIN-level for a real failover; any operator
for a scheduled drill in a non-production environment.

**Actions** (generic — provider-specific mechanics not yet chosen):
1. `<PROVIDER-SPECIFIC — not yet chosen: trigger the provider's own
   failover mechanism, e.g. a manual "reboot with failover" action or
   an automated health-check-triggered promotion of a standby>`.
2. Observe `GET /health/ready` throughout — expect a real, bounded
   period of 503s during the failover window (readiness intentionally
   never claims success it hasn't verified).
3. Confirm the API/worker processes reconnect to the new primary
   automatically once it's serving traffic again (Prisma's own
   connection pool re-establishes for new queries without a restart;
   verify this is actually true for the specific provider/driver
   combination chosen, since this has never been tested against a real
   managed provider in any session).
4. Record the actual observed failover duration — this is the real
   input the RTO target (`docs/production-database-readiness.md` §2)
   needs to be validated against, once measured.

**Safety checks**: never trigger a real production failover as a "test"
without prior explicit authorization and a announced maintenance
window — this is a real-impact action, not a read-only drill, once a
real provider is involved.

**Validation**: `GET /health/ready` recovers to 200; no financial
invariant violation introduced (re-run `financial-integrity-checks.js`
after).

**Escalation**: none needed for a planned drill; Sev1 process applies if
triggered by a real unplanned event.

**Do NOT**: claim failover capability is "tested" based on this
repository's own code alone — it requires a real provider and a real
executed drill, neither of which exists yet.

## J. Post-restore financial validation

**Status: IMPLEMENTED IN REPOSITORY, exercised this session.**

**Prerequisites**: a completed restore (any of runbooks E/F/G/H).

**Authorization**: any operator may run the checks; a SUPER_ADMIN must
sign off on the result before resuming real traffic.

**Actions**:
1. `npm run check:integrity -w apps/api` (`financial-integrity-
   checks.js`) against the restored instance — all 9 checks (§6 of the
   readiness document) must pass. **Never** treat a failing check as
   something to patch around — a failure here means the restore is not
   safe to promote, full stop.
2. Run `IndependentReconciliationService`'s rescan against every active
   asset/network (`POST /admin/reconciliation/:assetNetworkId/independent-
   rescan`) — catches on-chain activity the restore point missed,
   independent of whatever the restored watcher cursor claims.

**Safety checks**: this is read-only validation — neither step mutates
any balance/deposit/withdrawal.

**Validation**: all integrity checks pass; reconciliation rescan
produces zero new CRITICAL discrepancies (or every one found is
triaged before resuming).

**Escalation**: any integrity-check failure or CRITICAL discrepancy →
do not resume trading/withdrawal processing; treat as an unresolved
incident, escalate per `docs/operations-runbook.md` §11.

**Do NOT**: skip this step "to save time" before resuming traffic after
any restore, for any reason.

## K. Post-restore application validation

**Status: READY FOR IMPLEMENTATION** (procedure exists; not drilled at
production scale in any session).

**Prerequisites**: a restored, integrity-validated database (runbook J
passed).

**Authorization**: any operator.

**Actions**:
1. Point a staging/canary instance of the API at the restored database
   first, not production traffic directly.
2. `GET /health` and `GET /health/ready` both return 200.
3. Exercise a representative read path (list markets, fetch a known
   user's balance) and a representative write path in a controlled way
   (e.g. via the same manual verification Phase 18's real staging drill
   used — register a test account, confirm the expected
   PENDING_VERIFICATION → ACTIVE lifecycle still works).
4. Confirm the worker process starts cleanly and its heartbeat file
   updates (`scripts/worker-healthcheck.js`).
5. Only after all of the above: cut real traffic over.

**Safety checks**: never cut real user traffic directly onto a
freshly-restored database without this canary step.

**Validation**: all of the above pass cleanly.

**Escalation**: any failure here → back to runbook C/F, the restore
itself may be incomplete or the application/schema mismatch.

**Do NOT**: skip the canary step under incident-response time pressure —
a second, faster incident caused by cutting over a broken restore is
worse than a few extra minutes of validation.

## L. Migration failure

**Prerequisites**: a `prisma migrate deploy` run that failed partway, or
succeeded but produced unexpected/incorrect schema state.

**Authorization**: whoever is running the deployment; escalate to
SUPER_ADMIN-level if data appears affected, not just schema.

**Actions**:
1. **Take a backup FIRST if the database is still reachable and the
   failure is schema-only** (no data corruption suspected) —
   `docs/production-database-readiness.md` §8's new standing rule: back
   up immediately before attempting any migration-related fix.
2. `npx prisma migrate status` — determine exactly which migration
   failed and its exact state (applied-with-error vs. never-applied).
3. **If the migration never applied**: fix the migration file (if not
   yet released/shared) or write a new corrective forward migration (if
   already released) and redeploy — never edit a migration that has
   already been applied anywhere else.
4. **If the migration partially applied and left the schema
   inconsistent**: this is now a data-recovery event, not a routine
   fix — restore from the pre-migration backup (step 1, or the most
   recent one available) rather than attempting manual DDL surgery
   under pressure.
5. Re-run `npm run check:integrity` and the full backend test suite
   against the corrected schema before considering this resolved.

**Safety checks**: never run raw, hand-written `ALTER TABLE` statements
directly against a production database to "patch" a failed migration —
write a real migration file so migration history stays the single
source of truth for schema state.

**Validation**: `prisma migrate status` shows a clean, fully-applied
history; integrity checks pass; the test suite passes against the
corrected schema.

**Escalation**: Sev2 if schema-only and caught before real traffic
resumed; Sev1 if any data was affected.

**Do NOT**: claim "the migration is fixed" based on the schema looking
right — always verify via `prisma migrate status` and a real test run,
never a visual inspection alone.

## M. Security incident requiring database recovery

**Prerequisites**: a confirmed or strongly-suspected security incident
where the database itself may have been accessed/modified by an
unauthorized party (not merely an application-level vulnerability with
no DB impact — those follow `docs/operations-runbook.md`'s existing
incident-escalation process without necessarily needing a restore).

**Authorization**: highest-severity incident — SUPER_ADMIN plus
whoever holds security-incident-command authority; do not act
unilaterally.

**Actions**:
1. **Isolate first** — revoke/rotate every credential that could have
   been exposed (`docs/operations-runbook.md` §10, "Secret rotation")
   before doing anything else; an attacker with a still-valid credential
   can undo any recovery step in progress.
2. Preserve forensic evidence — a snapshot/backup of the CURRENT
   (possibly-compromised) state, taken before any restore, for later
   investigation — same principle as runbook C step 3, but here the
   preserved copy is also evidence for a security investigation, not
   just a corruption-analysis artifact.
3. Determine the last known-good point BEFORE the suspected compromise
   began — this requires correlating `AuditLog` entries, provider
   webhook/API access logs, and infrastructure-level access logs
   (`<PROVIDER-SPECIFIC — not yet chosen>` for whichever managed
   provider is eventually in use).
4. Restore to that point (runbook E if PITR exists once implemented,
   otherwise the most recent backup before that point — runbook F).
5. Run the full post-restore validation (runbooks J + K).
6. **Additionally**, specifically audit for unauthorized privilege
   escalation (`AuditLog` entries for `user.super_admin_bootstrap`,
   role changes, unexpected `CustodyProviderConfig`/
   `ComplianceProviderConfig` modifications) — a security incident's
   restore validation must check for *malicious* changes, not just
   *accidental* corruption, which is a different failure mode than
   runbooks C/D check for.
7. A full written postmortem is mandatory (`docs/operations-runbook.md`
   §11, item 3) — this is exactly the class of incident that requires
   one.

**Safety checks**: never restore over evidence before it's preserved;
never assume rotating credentials alone is sufficient without also
verifying via a restore/audit that no unauthorized data change
persisted.

**Validation**: runbooks J + K, plus the additional privilege-escalation
audit in step 6.

**Escalation**: this IS a Sev1/highest-priority incident by definition;
involve whoever owns security-incident response for the organization,
not just the on-call database operator.

**Do NOT**: treat this the same as an accidental-corruption/deletion
event — a security incident requires credential rotation and a
malicious-change audit that an accidental-cause incident does not.
