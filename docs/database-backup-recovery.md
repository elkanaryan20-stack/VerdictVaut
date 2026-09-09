# Database Backup & Recovery — Phase 12A

This document is the honest current state of VerdictVaut's PostgreSQL
backup/disaster-recovery posture, plus the real, runnable tooling this
phase adds. It does not claim anything is configured that isn't, and it
does not invent a production infrastructure decision (cloud provider,
managed Postgres service) that only the platform owner can make.

## 1. Current deployment model (as of Phase 12A)

The only Postgres infrastructure that exists in this repository is
`infra/docker-compose.yml` — a single local-development Postgres
container with one named Docker volume. There is no staging or
production deployment target defined anywhere in the repo.
`APP_ENVIRONMENT=production` is refused at boot (`env.validation.ts`)
independent of this document, for unrelated reasons (no custody
provider, no real collateralization was in place before this phase).

**What this means concretely: no automated backups exist today, because
no persistent, always-on database instance exists outside a developer's
own machine.** Everything below is split into (a) what this phase adds
that is real and works right now against the existing docker-compose
setup, and (b) what a real production deployment still requires,
documented as an explicit prerequisite rather than something already
done.

## 2. What Phase 12A actually adds (real, tested)

| Artifact | What it is |
|---|---|
| `infra/backup.sh` | Runs `pg_dump -Fc` inside the running `verdictvaut-postgres` container, writes a timestamped compressed dump to `infra/backups/`, fails loudly (not silently) on a truncated/empty dump, and prunes local dumps older than `RETENTION_DAYS` (default 30). |
| `infra/restore.sh` | Restores a dump produced by `backup.sh` into a **new**, separate database — never overwrites the live one. Prints the exact next verification steps rather than silently promoting the restored data. |
| `apps/api/scripts/backup-restore-drill.js` (`npm run backup:drill` from `apps/api`) | A real, executable end-to-end backup/restore test — see §6. |

These are genuinely useful for a single-VM/self-hosted deployment of the
existing docker-compose setup. They are **not** a substitute for a
managed provider's automated backups/PITR in a real multi-instance
production deployment — see §7.

## 3. Backup strategy

- **Full backups**: `infra/backup.sh`, using `pg_dump`'s custom format
  (`-Fc`) — compressed, and restorable selectively (schema-only,
  data-only, specific tables) via `pg_restore`, unlike a plain SQL dump.
  Recommended cadence for a self-hosted deployment: at minimum daily,
  via cron/systemd-timer/Task Scheduler calling `infra/backup.sh`.
- **Incremental / WAL-based backups**: `pg_dump` is a **logical**
  backup — it captures a snapshot at one point in time, not continuous
  WAL. True point-in-time recovery (restore to any second between
  backups, not just to the last full-backup boundary) requires WAL
  archiving (`archive_mode = on` + `archive_command`, or a tool like
  `pgBackRest`/`WAL-G`) continuously shipping WAL segments to durable
  storage. **This is not configured** — the stock `postgres:16-alpine`
  image in `infra/docker-compose.yml` runs with default (non-archiving)
  WAL settings. Enabling this is a real, moderate-effort infrastructure
  change (WAL archive destination, retention, disk-space planning) that
  belongs to whichever production hosting decision is made — not
  invented speculatively here.
- **Retention**: `infra/backup.sh` defaults to 30 days of local dumps.
  A real production retention policy (e.g. daily for 30 days, weekly for
  90 days, monthly for 1 year) is a business/compliance decision, not an
  engineering default — configurable via `RETENTION_DAYS`, not hardcoded
  as a claim of correctness.
- **Encryption**: `infra/backup.sh` does not encrypt the dump file. For
  any backup leaving `infra/backups/` (off-site copy, cloud storage
  upload), encrypt it first (e.g. `gpg --symmetric` or your cloud
  provider's server-side encryption) — **not implemented here**, since
  it requires a key-management decision (where the key lives, who can
  decrypt) this phase should not make unilaterally.
- **Off-site storage**: `infra/backup.sh` writes only to local disk.
  A local-disk-only backup does not protect against the single most
  common real disaster (the host/disk itself failing or being lost) —
  **an off-site copy (S3/GCS/another region/another provider entirely)
  is a hard requirement before this counts as real disaster-recovery
  coverage**, and is not implemented here because it requires choosing
  a destination and credentials.
- **Access control**: whoever can read `infra/backups/*.dump` can read
  every user's financial history in plaintext (pg_dump output is not
  encrypted by default — see above). Treat backup files with the same
  access-control rigor as production database credentials, not as
  ordinary files.

## 4. RPO / RTO

Per the phase brief's own instruction: do not invent guarantees.

| Environment | RPO (Recovery Point Objective) | RTO (Recovery Time Objective) |
|---|---|---|
| Development (current state) | No SLA — this is a developer's local database | No SLA |
| Production | **TBD — undecided.** Depends on backup cadence (§3) and whether WAL archiving/PITR is implemented. A daily `pg_dump`-only strategy implies an RPO of up to 24h (worst case: lose everything since the last successful backup). A real production RPO/RTO target is a business decision (how much data loss and downtime is acceptable) that must be made explicitly, then implemented to match — not assumed. | **TBD — undecided**, same reasoning. |

**Do not deploy to production trading real funds until RPO/RTO targets
have been explicitly decided and the backup/WAL-archiving configuration
required to actually meet them is in place and tested.**

## 5. Restore procedure

1. **Identify the incident** — data corruption, accidental deletion, a
   bad migration, host loss. Determine the last known-good point in
   time.
2. **Stop application writes** if the primary database is still
   reachable and the incident is ongoing (e.g. a runaway bad migration)
   — scale the API to zero / stop the process. Skip this step only if
   the primary is already unreachable (host loss).
3. **Preserve the current (possibly-corrupted) database** before
   touching anything — take a `pg_dump` of it even if it's suspected bad,
   and/or snapshot the volume. You cannot un-delete a restore target you
   overwrote by mistake.
4. **Restore the backup** — `infra/restore.sh <dump-file>` (into a new,
   separate database; see script for exactly what it does).
5. **Replay WAL / PITR** if WAL archiving is configured (§3) — not
   applicable to the current docker-compose deployment, since it isn't
   configured; document this step for whichever production setup
   eventually implements it.
6. **Verify migrations** — `npx prisma migrate status` against the
   restored database; it must show every migration applied, none
   pending/failed.
7. **Verify ledger invariants** — every `LedgerTransaction`'s entries
   sum to zero; no `LedgerAccount` violates its non-negative-balance
   constraint (the DB CHECK constraints re-verify this automatically on
   any write, but a read-only audit query catches a pre-existing
   violation before the first write happens — see §6.4's checks).
8. **Verify deposit/withdrawal state** — every `CREDITED` deposit has a
   real `LedgerTransaction`; every completed withdrawal's reservation was
   actually released/captured, never both.
9. **Verify reconciliation state** — check `BlockchainWatchCursor` rows
   for staleness once the app restarts (a restored-from-yesterday cursor
   will re-scan a day's worth of chain activity — expected, not a bug,
   given every credit path is idempotent, but confirm the watcher
   actually resumes rather than erroring).
10. **Restart the application** pointed at the verified, restored
    database.
11. **Run post-restore integrity checks** (§6.4) one more time against
    the live, restarted instance before declaring the incident resolved.

**Explicit warning, per the phase brief's own requirement**: restoring
the database to an earlier point in time can create real inconsistency
with the outside world that no database-level check can catch — a
blockchain deposit or withdrawal broadcast that happened AFTER the
backup's snapshot point will not be reflected in the restored database,
but the underlying on-chain transaction still happened. **After any
restore, an admin must run `IndependentReconciliationService`'s
independent rescan (see `POST /admin/reconciliation/:assetNetworkId/independent-rescan`,
added this phase) against every active asset/network before resuming
normal operation** — it is specifically designed to detect exactly this
class of gap (chain activity with no corresponding internal record),
independent of whatever the restored watcher cursor claims. Do not
resume trading/withdrawal processing until that rescan has run clean or
every finding has been triaged.

## 6. Restore verification status — **a real drill was executed, honestly reported**

Per the phase brief: "Never claim a restore test happened if it did
not." The following actually ran, on this date, with these results —
not a hypothetical description.

### 6.1 What was run

`apps/api/scripts/backup-restore-drill.js` (`npm run backup:drill`):

1. Started a real, disposable Postgres instance (`embedded-postgres` —
   the same package the integration test suite already uses).
2. Applied the real, committed Prisma migrations (all 17, including this
   phase's own) and the real seed data.
3. Inserted real sample financial data: a user, a balanced double-entry
   `LedgerTransaction` (a $100 USDC deposit — `USER` +100 /
   `EXTERNAL_CHAIN` -100).
4. Cleanly stopped that instance and took a **cold physical (filesystem)
   backup** — copying the stopped data directory — because this
   embedded Postgres distribution ships no `pg_dump`/`pg_restore`/`psql`
   client binaries (server + `pg_ctl` + `initdb` only). This is a real,
   standard Postgres backup method
   ([file-system-level backup](https://www.postgresql.org/docs/current/backup-file.html)),
   distinct from the `pg_dump`-based `infra/backup.sh` above.
5. Started a **second, separate** Postgres instance directly against the
   copied data directory — simulating a genuine restore onto a fresh
   host.
6. Verified the restored instance for real: queried the sample user and
   ledger account back out, confirmed the ledger transaction's entries
   still summed to exactly zero, confirmed the full migration history
   was intact, and ran a platform-wide "every ledger transaction
   balances to zero" integrity sweep.

### 6.2 Result

**PASSED — 12/12 checks**, actually executed this session (the last 8
are the full reusable financial-integrity suite from §6.4, run for real
against the restored instance, not just described):

```
[PASS] restored user record exists with matching email
[PASS] restored ledger account balance intact
[PASS] restored ledger transaction still balances to exactly zero — sum=0
[PASS] migration history intact — before=17 after=17
[PASS] [integrity] every ledger transaction balances to zero — 0 of 1 unbalanced
[PASS] [integrity] no USER/MARKET ledger account violates the non-negative-balance invariant — 0 violation(s)
[PASS] [integrity] every FundReservation's consumedAmount is within [0, amount] — 0 violation(s)
[PASS] [integrity] every PositionReservation's consumedAmount is within [0, amount] — 0 violation(s)
[PASS] [integrity] every CREDITED deposit has a ledgerTransactionId — 0 of 0 missing
[PASS] [integrity] settled-position count matches PositionSettlement row count — positions=0 settlements=0
[PASS] [integrity] every settlement's payoutAmount equals quantity * payoutPerShare — 0 of 0 mismatched
[PASS] [integrity] every RESOLVED market's collateral account reached exactly zero — 0 market(s) with leftover/negative collateral
```

One honest observation from the actual run: Postgres logged `database
system was not properly shut down; automatic recovery in progress` when
starting the restored copy, then successfully replayed its WAL and came
up fully consistent. This means the drill incidentally also exercised
Postgres's own WAL crash-recovery path, not a guaranteed-clean shutdown
checkpoint — and it still worked. This is worth knowing, not hiding.

### 6.3 What this drill does NOT prove

- **WAL-based point-in-time recovery** — not exercised (no WAL
  archiving/`pg_basebackup` tooling available in this embedded
  distribution). Only full-database cold-backup restore was tested.
- **Performance/duration at real production data volume** — the drill
  data is trivially small (one user, one ledger transaction).
- **Anything about a specific managed-provider's backup/restore
  mechanism** — whichever production Postgres provider is eventually
  chosen (RDS, Cloud SQL, a self-hosted `pgBackRest` setup, etc.) has its
  own backup/restore path that must be independently drilled before
  going live. This drill validates the *database engine's* durability
  and this repo's *migration/data model's* restorability — it is not a
  substitute for testing the actual production backup mechanism once one
  exists.
- **The `pg_dump`/`pg_restore` path** (`infra/backup.sh`/`restore.sh`)
  specifically — the drill used cold physical backup instead, since that
  was the tool actually available. Before relying on `infra/backup.sh`
  in anger, run it against a live docker-compose instance and restore it
  with `infra/restore.sh` at least once — that exact cycle was not
  re-verified by the automated drill above (though `pg_dump -Fc` /
  `pg_restore` is extremely well-trodden Postgres tooling, not novel
  code this phase wrote).

### 6.4 Financial integrity checks used (reusable — Part 19)

`apps/api/scripts/financial-integrity-checks.js` (`npm run
check:integrity` from `apps/api`, against whatever `DATABASE_URL` is
set) is a standalone, reusable module — not a one-off embedded in the
drill. It runs:

1. Every `LedgerTransaction`'s `LedgerEntry` rows sum to exactly zero.
2. No `USER`/`MARKET`-owned `LedgerAccount` violates the non-negative-
   balance invariant (an independent audit, not just trusting the DB
   CHECK constraint caught everything retroactively).
3. Every `FundReservation`/`PositionReservation`'s `consumedAmount` is
   within `[0, amount]`.
4. Every `CREDITED` deposit has a real `ledgerTransactionId`.
5. The count of settled `Position` rows matches the count of
   `PositionSettlement` rows.
6. Every `PositionSettlement.payoutAmount` equals `quantity *
   payoutPerShare` exactly.
7. Every `RESOLVED` market's own collateral `LedgerAccount` (Phase 12A)
   reached exactly zero — proof settlement fully and exactly consumed
   the collateral it should have, no more, no less.

This module is directly reusable during a real incident (§5 step 7), as
a periodic standalone health check (`npm run check:integrity`), and —
as of this phase — is genuinely exercised by the backup/restore drill
itself (§6.1 step 6), not just described as "you could run this."

## 7. Production prerequisites — explicit, not fabricated

Before this platform holds real user funds in production, the following
must exist (none of it does today):

1. **A chosen managed Postgres provider or self-hosted HA setup** —
   whichever is chosen determines what "automated backups" actually
   means operationally (e.g. AWS RDS automated snapshots + PITR are
   built-in; a self-hosted box needs `infra/backup.sh` on a cron plus WAL
   archiving configured manually).
2. **WAL archiving / continuous backup**, if true point-in-time recovery
   (not just "restore to last nightly backup") is required — a real RPO
   decision (§4) drives whether this is necessary.
3. **Off-site, encrypted backup storage** — §3's two unimplemented items.
4. **A documented, tested restore runbook specific to the chosen
   provider** — this document's §5 is the generic procedure; the
   provider-specific mechanics (e.g. "restore an RDS snapshot," "gcloud
   sql instances clone") still need to be written and drilled once a
   provider is chosen.
5. **Explicit RPO/RTO targets**, signed off by whoever owns that
   business decision, with the backup cadence/architecture actually
   built to meet them (§4).
6. **A recurring drill schedule** — a restore test run once during
   development (§6) proves the mechanism CAN work; it does not prove it
   WILL work six months from now against a schema that has evolved.
   Re-run some form of this drill (ideally against the actual production
   backup mechanism, on a realistic data copy) on a recurring cadence,
   not as a one-time checkbox.
