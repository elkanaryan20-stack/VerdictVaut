# Production Database Readiness — Phase 22

This document is the Phase 22 deliverable: explicit RPO/RTO targets, a
provider-neutral backup contract, an HA/failover assessment, a migration
safety summary, a backup security review, a drill/test cadence
recommendation, and a final production database readiness checklist.

It does **not** duplicate `docs/database-backup-recovery.md` (Phase 12A
— the backup/restore mechanism, the real drill result, the restore
procedure) or `docs/production-database-requirements.md` (Phase 16 —
TLS, connection pooling, migration deployment process) — both remain
the authoritative source for what they already cover. This document
cross-references them and adds what Phase 22 was specifically asked
for: explicit targets, a formal contract, and an HA assessment, none of
which existed before this phase.

Every claim below is labeled one of:

- **IMPLEMENTED IN REPOSITORY** — real, runnable, and (where marked)
  actually executed this session.
- **REQUIRES PRODUCTION INFRASTRUCTURE** — a real capability that needs
  a managed provider or infrastructure decision this repository cannot
  make on its own.
- **NOT YET VERIFIED** — code/tooling exists but has not been exercised
  against the thing it would need to be exercised against (Docker, a
  real managed provider) in any session.

No cloud provider is selected here. `docs/production-database-requirements.md`
§5 and `docs/database-backup-recovery.md` §7 already state explicitly
that none has been chosen anywhere in this repository's history —
unchanged by this phase.

## 1. Current state audit (Phase 8 → 19, read before writing anything)

| Capability | Status | Evidence |
|---|---|---|
| Logical backup (`pg_dump -Fc`) | IMPLEMENTED IN REPOSITORY | `infra/backup.sh` (Phase 12A) — Docker-dependent, **NOT EXECUTED against Docker this session** (unavailable, as in every prior session) |
| Restore into a new, disposable database | IMPLEMENTED IN REPOSITORY | `infra/restore.sh` (Phase 12A) — same Docker caveat |
| Backup integrity verification (checksum) | IMPLEMENTED IN REPOSITORY (this phase) | `infra/backup.sh` now writes a `.sha256` alongside every dump; `infra/restore.sh` verifies it before restoring, and refuses if it doesn't match — see §6. Syntax-validated (`bash -n`) only; not run against Docker. |
| Backup metadata / failed-job record | IMPLEMENTED IN REPOSITORY (this phase) | `infra/backups/backup-metadata.jsonl`, one line per attempt (success or failure) — see §7 |
| Real, executed restore drill | IMPLEMENTED IN REPOSITORY, **actually run this session** | `apps/api/scripts/backup-restore-drill.js` — physical (filesystem) backup/restore against `embedded-postgres`, now covering every financial table category (§4/§5) — **22/22 checks PASSED**, this session, see §5 |
| Financial invariant checks | IMPLEMENTED IN REPOSITORY, **actually run this session** | `apps/api/scripts/financial-integrity-checks.js` — 9 checks (7 from Phase 12A + 2 added this phase), all passed against the drill's restored instance |
| WAL archiving / continuous backup / PITR | REQUIRES PRODUCTION INFRASTRUCTURE | Never configured — `docs/database-backup-recovery.md` §3 (unchanged) |
| Off-site, encrypted backup storage | REQUIRES PRODUCTION INFRASTRUCTURE | Never configured — same document, same section |
| Managed provider / self-hosted HA | REQUIRES PRODUCTION INFRASTRUCTURE | Never chosen — `docs/production-database-requirements.md` §5 |
| Explicit RPO/RTO targets | **Added this phase** (§2 below) | Previously "TBD" (`docs/database-backup-recovery.md` §4) — now has a proposed conservative target, still explicitly not achieved |
| Migration safety guard | IMPLEMENTED IN REPOSITORY | `guard-destructive-migration.js` (Phase 16) — known limitation (checks env var names, not `DATABASE_URL`'s value) restated in §8, not re-fixed here |
| Production readiness gate (backup-specific) | IMPLEMENTED IN REPOSITORY, upgraded this phase | `production-readiness-check.js` now distinguishes a genuinely-passing local-tooling check from an honestly-`NOT CONFIGURED` managed-infrastructure check — see §9 |

Nothing above was assumed from a prior phase's own report without
independently re-reading the actual current file — see the Evidence
column for exactly what was inspected.

## 2. RPO / RTO — explicit proposed targets

`docs/database-backup-recovery.md` §4 left both **TBD** — an honest,
correct call at the time (no infra existed to discuss cadence against).
This phase proposes conservative initial targets appropriate for a
financial application, per the phase brief's own suggestion — **these
are TARGETS, not achieved values**:

| | **TARGET (proposed)** | **CURRENTLY IMPLEMENTED** | **REQUIRES** |
|---|---|---|---|
| RPO (data loss window) | ≤ 5 minutes | **Effectively unbounded.** No backup scheduler exists anywhere in this repository (no cron/systemd-timer/managed job) — `infra/backup.sh` only runs when a human invokes it. A daily manual/cron `pg_dump` gives a *worst-case* RPO of up to 24h; there is no evidence any cadence is actually configured today. | Continuous WAL archiving (`archive_mode=on` + `archive_command`, or `pgBackRest`/`WAL-G`), or a managed provider's built-in continuous-backup/PITR feature (e.g. automated snapshots + transaction-log shipping). Nothing at ≤5min RPO is achievable with periodic `pg_dump` alone, regardless of how frequently it's scheduled. |
| RTO (time to restore service) | ≤ 60 minutes | **Not measured against production scale.** The drill in §5 restores a trivially small dataset in well under a minute — that proves the *mechanism* works, not that a real production-sized database restores within any specific window. | A tested restore procedure against realistic data volume, on the actual chosen provider's restore path (snapshot restore, WAL replay time, DNS/connection-string cutover) — none of which can be measured without that provider chosen and provisioned. |

**Why these specific numbers**: ≤5min RPO and ≤60min RTO are common,
conservative starting points for a financial application handling real
user funds — tighter than "nightly backup is fine" (unacceptable data
loss for a trading platform), looser than "zero data loss" (which
requires synchronous multi-region replication, a materially larger
infrastructure/cost commitment that should be a deliberate choice, not
a default). **This document does not have the authority to make these
final** — they are a proposal for whoever owns the production
business/compliance decision to accept, tighten, or loosen, then build
the infrastructure to actually meet whatever is decided.

**Do not deploy to production with real funds until RPO/RTO targets are
explicitly signed off and the infrastructure to meet them is in place
and tested** — restated from `docs/database-backup-recovery.md` §4,
unchanged.

## 3. Provider-neutral backup contract

A checklist any backup solution — self-hosted or managed — must satisfy
before it counts as real production disaster-recovery coverage. This is
documentation/a contract, not application code — Phase 22 was
explicitly told not to build a fake backup provider.

| Requirement | Local tooling today | What a real solution needs |
|---|---|---|
| Automated PostgreSQL backups | Manual invocation only (`infra/backup.sh`) | A scheduler (cron/systemd-timer/managed-provider automated snapshots) — not built here, see §2 |
| WAL / PITR | Not implemented | `archive_mode`+`archive_command`, `pgBackRest`/`WAL-G`, or a managed provider's built-in PITR |
| Retention | `RETENTION_DAYS` env var, local-disk pruning only | A real, business-approved retention policy (e.g. daily×30, weekly×90, monthly×1yr) enforced on durable, off-site storage |
| Backup encryption | **Not implemented** — `pg_dump` output is plaintext | Encrypt at rest (managed-provider default, or `gpg --symmetric`/equivalent before any off-site copy) with a real key-management decision (who holds the key, rotation) |
| Backup integrity verification | Implemented this phase — sha256 checksum written alongside every dump, verified by `restore.sh` before restoring (see §6) | Same principle, whatever the storage mechanism — never trust an un-verified backup artifact |
| Restore | `infra/restore.sh` — always into a NEW database, never overwrites the live one | Same non-negotiable property for any provider's restore path |
| Restore-to-new-instance | Implemented (`restore.sh`'s whole design) | — |
| Point-in-time recovery | Not implemented (no WAL) | Requires the WAL/PITR row above |
| DR region/location | Not applicable — single local/docker-compose instance | An off-site (different disk, different host, ideally different region/provider) copy — the single most-skipped, most-necessary item; local-disk-only backups do not survive the host/disk that also holds the live database failing |
| Access control | Not implemented — anyone who can read `infra/backups/*.dump` can read every user's financial history in plaintext | Treat backup storage access with the same rigor as production DB credentials; a managed provider's IAM/bucket policies, or equivalent host-level permissions for self-hosted |
| Backup deletion protection | Not implemented | Object-lock / WORM storage (S3 Object Lock, GCS retention policy, or equivalent) where the chosen storage supports it — prevents an attacker (or a mistake) from deleting backups as part of a destructive incident |

**Backup credentials are never placed in application code** — this
repository's existing `secret-ref.validator.ts`/`SecretResolverService`
pattern (Phase 14A, `"scheme:path"` references resolved only via the
`env:` scheme today) is the established precedent for how any future
backup-storage credential should be handled if this contract is ever
implemented against a real provider — not invented fresh here.

## 4. Local backup/restore tooling — what changed this phase

- `infra/backup.sh`: now writes a sha256 checksum file (`<dump>.sha256`)
  alongside every backup, and appends one JSON line per attempt
  (success or failure, `infra/backups/backup-metadata.jsonl`) — never
  including `DATABASE_URL`, a password, or any other credential.
- `infra/restore.sh`: now (a) refuses outright if the target database
  name matches the configured *active* database name (`POSTGRES_DB`) —
  an explicit safeguard against ever restoring over the live database,
  on top of the pre-existing "always creates a new DB" behavior — and
  (b) verifies the backup's checksum before restoring, refusing on a
  mismatch (a missing checksum file — e.g. an older backup predating
  this feature — is a WARNING, not a hard failure).
- Both scripts remain Docker-dependent for actual execution; Docker is
  unavailable in this environment (unchanged across every session that
  has worked on this repository). **Syntax-validated (`bash -n`) only —
  not executed against a real container this session.**

## 5. Restore validation — actually run this session

`npm run backup:drill -w apps/api` (`apps/api/scripts/backup-restore-drill.js`),
broadened this phase to insert and verify a real sample row for every
table category the phase brief lists:

| Table category | Verified recoverable |
|---|---|
| Users | ✅ |
| Ledger accounts | ✅ |
| Ledger entries (double-entry) | ✅ |
| Fund reservations | ✅ |
| Orders / fills / positions | ✅ (order pair, fill, position) |
| Deposits | ✅ (a CREDITED deposit, with its `ledgerTransactionId` intact) |
| Withdrawals | ✅ (a REQUESTED withdrawal) |
| Reconciliation records | ✅ (a `ReconciliationRun` + `ReconciliationDiscrepancy`) |
| Settlement records | ✅ (a `PositionSettlement`, with its own real settlement `LedgerTransaction`) |

**Result, this session: PASSED — 22/22 checks**, including the 9-check
financial-integrity suite (see §6 below) run against the restored
instance. Exact command and full output are reproducible via `npm run
backup:drill -w apps/api`; nothing here is a hypothetical description.

Unchanged limitations from Phase 12A (still true, not re-solved this
phase): this drill exercises a **physical** (filesystem-level) backup
via `embedded-postgres`, not the `pg_dump`/`pg_restore` path
`infra/backup.sh`/`restore.sh` actually use (that pair needs a live
Docker container to exercise, unavailable here); it proves the database
engine's and this schema's restorability, not any specific managed
provider's backup mechanism; performance at real production data volume
is not measured (the drill's dataset is trivially small).

The restore drill **never mutates the source ("primary") instance** —
it is stopped cleanly, copied, and the copy alone is what gets restored
into and verified; the original is torn down afterward, not written to
again.

## 6. Financial recovery invariants

`apps/api/scripts/financial-integrity-checks.js` — read-only, never
"fixes" anything it finds; a violation is reported and the check fails,
full stop. Nine checks total (7 from Phase 12A, 2 added this phase):

1. Every ledger transaction's entries sum to exactly zero.
2. No USER/MARKET ledger account violates the non-negative-balance
   invariant.
3. Every `FundReservation`'s `consumedAmount` is within `[0, amount]`.
4. Every `PositionReservation`'s `consumedAmount` is within `[0, amount]`.
5. Every `CREDITED` deposit has a real `ledgerTransactionId`.
6. Settled-position count matches `PositionSettlement` row count.
7. Every settlement's `payoutAmount` equals `quantity * payoutPerShare`.
8. Every `RESOLVED` market's collateral account reached exactly zero.
9. **(Phase 22)** Every `BROADCAST`/`CONFIRMING`/`CONFIRMED`/`CREDITED`
   withdrawal has a real `txHash` — independently audits the same
   invariant `withdrawals_broadcast_requires_txhash_check` (Phase 9)
   already enforces at write time, catching pre-existing data that
   predates the constraint (e.g. a restore from an older schema).
10. **(Phase 22)** Every `ReconciliationDiscrepancy`'s resolution fields
    (`resolvedAt`/`resolvedByUserId`) are consistent with its status —
    independently audits `reconciliation_discrepancies_resolution_consistency_check`
    (Phase 12A), same reasoning.

All 10 (the module still calls them a 9-item numbered list internally,
counting #9/#10 above as items 8/9 of its own sequence — see the file)
passed against the restored instance in §5's drill run.

## 7. Backup security review

| Item | Finding |
|---|---|
| Secrets in backup scripts | None — `infra/backup.sh`/`restore.sh` read `POSTGRES_USER`/`POSTGRES_DB`/etc. from env vars, never hardcode a credential, and the new checksum/metadata additions this phase never write `DATABASE_URL`, a password, or any credential value to any file. |
| `DATABASE_URL` leakage | Not applicable — these scripts operate via `docker exec`/container credentials, not a `DATABASE_URL` connection string, so there is nothing of that shape to leak. |
| Shell history | `infra/backup.sh`/`restore.sh` take no credential as a command-line argument (only a container name, DB name, dump-file path) — nothing credential-shaped would land in shell history from normal use. |
| Backup file permissions | **Not enforced by these scripts** — `infra/backups/*.dump` inherits whatever the local filesystem's default permissions are. A real deployment must restrict this explicitly (this repo cannot enforce host-level file permissions from a shell script alone). |
| Backup encryption | **Not implemented** (§3) — plaintext `pg_dump` output; a real off-site copy must be encrypted first. |
| Backup storage permissions | Not applicable yet — no off-site storage exists to have a permission model for. |
| Production/staging separation | `restore.sh` now explicitly refuses to target the configured active database name (§4) — a real, new safeguard against the single most dangerous accidental-restore scenario. |
| Accidental restore into production | Addressed structurally: `restore.sh` has never overwritten the live database (always creates new), and now additionally refuses on a name collision (§4). |
| Logging of sensitive connection info | `backup.sh`'s new metadata log (`backup-metadata.jsonl`) records only timestamp, filename, size, database name, and status — never a connection string, host, port, or credential. |

No secret, credential, or production `DATABASE_URL` was added to this
repository by this phase.

## 8. Migration safety — summary (full detail unchanged, see cross-refs)

- Production migrations run via `prisma migrate deploy` only — never
  `migrate dev`/`migrate reset` — enforced for the npm-script path by
  `guard-destructive-migration.js` (Phase 16); the documented,
  unresolved limitation (checks env var names, not `DATABASE_URL`'s
  actual value) is unchanged and is **not** re-fixed by this phase —
  see `docs/production-database-requirements.md` §4 for the full
  reasoning on why a connection-string heuristic was deliberately not
  built.
- **Prisma has no generated "down" migration / rollback mechanism.**
  Schema rollback (undoing a bad migration's *structure*) and data
  recovery (getting back *data* lost by a bad migration) are explicitly
  distinct, per `docs/operations-runbook.md` §3: schema rollback means
  writing and applying a new forward migration that reverses the change
  (preferred), and data recovery — if the migration already caused data
  loss a forward migration can't undo — means restoring from a
  pre-migration backup (§5 above), which is a disaster-recovery event,
  not a routine rollback.
- **A documented backup requirement before migrating** — not previously
  stated explicitly as a standing rule; stated here: **run
  `infra/backup.sh` (or the equivalent for whatever production Postgres
  is eventually chosen) immediately before any `prisma migrate deploy`
  against a database holding real data.** This costs one command and
  turns "a migration went wrong" from a potential disaster-recovery
  event into "restore the backup taken 30 seconds ago."
- Migrations are applied as a separate, single-instance step, never
  baked into container startup (`apps/api/Dockerfile`'s own comment,
  unchanged) — never races N replicas against the same migration.

## 9. Production readiness gate — what changed this phase

`production-readiness-check.js`'s single, permanently-`false` backup
check was replaced with two honestly distinct ones:

```
[PASS]           (P2) Local backup/restore tooling exists and a restore drill is runnable
[NOT CONFIGURED] (P1) Managed production backup infrastructure (automated backups, WAL/PITR, off-site encrypted storage) is decided and provisioned
```

The script's `check()` helper now carries an explicit `status` field
(`PASS`/`FAIL`/`NOT CONFIGURED`, defaulting to the boolean-derived
`PASS`/`FAIL` for every pre-existing call site — additive, not a
behavior change elsewhere) — this is the PASS/WARN/FAIL/NOT-CONFIGURED
distinction the phase brief asked for. **Production still correctly
reports BLOCKED** — the managed-infrastructure check is P1 and still
fails; nothing here weakens the gate, it only makes what's real (local
tooling) distinguishable from what isn't (managed production
infrastructure) instead of both being reported as one flat `FAIL`.
Local development is unaffected — this check has always been, and
remains, evaluated the same way regardless of `APP_ENVIRONMENT`.

## 10. Database HA / failover assessment

**What the application already supports:**

- `SerializableTransactionRunner` (`src/prisma/serializable-transaction-runner.ts`)
  retries a bounded number of times (default 15, exponential backoff
  with jitter) on a genuine Postgres **serialization failure**
  (SQLSTATE `40001`) or an internal stale-snapshot conflict. This is
  real, tested retry behavior for write contention under `SERIALIZABLE`
  isolation.
- `PrismaService.onModuleInit()` connects eagerly at boot — both the API
  and worker processes fail closed at startup if the database is
  unreachable, rather than starting in a half-working state.
- `GET /health/ready` returns 503 (never crashes) when the database is
  unreachable — proven live in Phase 18's real database-outage
  injection test (`pg_ctl stop -m immediate` while the API/worker were
  running): the worker's poll loop caught each failure, logged and
  metriced it, and never crashed; readiness recovered automatically once
  Postgres came back, with no process restart needed.

**A real, previously-undocumented gap found by this phase's audit:**
`SerializableTransactionRunner` retries **serialization failures only**
— it does **not** retry a transaction that fails because the
*connection itself* was lost mid-flight (a Prisma `P1001`/connection-
reset error does not match `isSerializationFailure()`). Concretely: a
managed provider's automated failover (e.g. a Multi-AZ failover window
of roughly 60–120 seconds, order-of-magnitude, varies by provider) would
surface as a genuine, propagated error to whatever caller's transaction
was in flight during that window — not be silently absorbed and
retried. New connections/queries made *after* the failover completes
work normally (Prisma's connection pool reconnects on its own for new
work); it is specifically an **in-flight** transaction during the outage
window that fails outright today. This is a real, honest limitation to
carry into any HA design — not a defect to silently patch here (doing
so safely would require deciding whether/how to retry an entire
multi-statement financial transaction after an indeterminate connection
loss, which risks exactly the kind of blind side-effect-retry
`SerializableTransactionRunner`'s own docblock explicitly warns against
for non-database side effects — a real design decision, not a quick fix,
and out of this phase's scope).

**What this application does NOT need at current scale:**

- **Read replicas** — nothing in this codebase reads from a replica;
  every Prisma call goes through the single `DATABASE_URL`
  (`docs/production-database-requirements.md` §5, unchanged, re-verified
  this phase).
- **Multi-region active-active** — this is a single-primary application
  by construction; nothing here assumes or benefits from active-active
  writes across regions.

**What a real production deployment requires from the DB provider**
(none of which this repository can implement itself):

| HA tier | What it buys | What's needed |
|---|---|---|
| Single managed primary + automated failover (e.g. RDS Multi-AZ, Cloud SQL HA) | Survives a primary instance/AZ failure with an automated (if not instant) recovery | A managed provider decision + accepting the in-flight-transaction-failure gap above during the failover window |
| Read replica | Read scaling, not failover by itself (needs promotion logic to also serve as a failover target) | Not currently useful — nothing reads from a replica today (see above); would require application changes to route any read traffic there |
| Multi-AZ | Failure isolation within a region | Provider configuration; the connection/retry gap above still applies during a failover event |
| Regional DR / cross-region replica | Survives a full region outage | A genuinely larger commitment — cross-region replication lag, a documented regional-failover runbook (see `docs/disaster-recovery-runbooks.md` §G), and its own RTO/RPO analysis distinct from single-region HA |

**What needs testing once a provider is chosen** (not testable without
one): actual failover duration under this application's real connection
pool settings; whether `SerializableTransactionRunner`'s bounded retry
count/timeout values remain appropriate against a real failover window
of unknown-until-measured duration; connection-pool re-establishment
behavior on both the API and worker processes.

## 11. Backup/restore test cadence — recommendation only

No automation is created by this phase (explicitly out of scope) — this
is a documented recommended cadence for whoever operates this in
production to actually schedule:

| Activity | Recommended cadence |
|---|---|
| Automated backup monitoring (backup-metadata.jsonl / provider equivalent) | Continuous — every backup attempt should produce a checkable signal (see `docs/observability-and-alerting.md` alert #7) |
| Restore verification (a drill like §5, or the real `infra/backup.sh`+`restore.sh` pair) | At minimum monthly, and after any schema-affecting migration or Prisma version upgrade |
| Full disaster-recovery drill (against whatever the real chosen production mechanism is) | Quarterly |
| PITR drill (once WAL archiving exists) | Quarterly, alongside the DR drill |
| Failover drill (once a managed-HA provider is chosen) | Quarterly |

A restore drill run once during development (as this phase did) proves
the mechanism CAN work today; it does not prove it will keep working
against a schema that continues to evolve — re-running some form of
this on a recurring cadence is the only thing that keeps that proof
current (`docs/database-backup-recovery.md` §7, unchanged, restated
here because it's the direct justification for this table).

## 12. Production database readiness checklist

- [ ] Managed Postgres provider (or self-hosted HA setup) chosen —
      **NOT DONE**
- [ ] `DATABASE_URL` enforces TLS in production — code-level gate exists
      (`database-tls.validator.ts`), **not exercised against a real
      provider connection**
- [ ] Automated backups configured on the chosen provider — **NOT
      DONE** (local manual/cron-only tooling exists, see §3/§4)
- [ ] WAL archiving / PITR configured — **NOT DONE**
- [ ] Off-site, encrypted backup storage — **NOT DONE**
- [ ] Explicit RPO/RTO targets signed off by the business owner — a
      **proposed** target now exists (§2); not yet accepted/rejected by
      anyone with the authority to do so
- [ ] A restore drill has been run against real committed
      migrations/data — **DONE this session** (§5), locally, against
      `embedded-postgres` — **not yet done against the real chosen
      production mechanism**, because none is chosen
- [ ] Financial integrity checks pass post-restore — **DONE this
      session** (§6), 9/9 checks passed
- [ ] Backup integrity verification (checksum) implemented — **DONE
      this phase** (§4), Docker execution **NOT EXECUTED**
- [ ] Migration deployment process documented and guarded — **DONE**
      (`guard-destructive-migration.js`, `prisma migrate deploy` process)
      with a known, accepted, documented limitation
- [ ] HA/failover requirements documented — **DONE this phase** (§10)
- [ ] Failover actually drilled against a real provider — **NOT DONE**
      (no provider chosen)
- [ ] Operational runbooks exist for backup/restore/corruption/
      deletion/PITR/regional-disaster/failover/migration-failure/
      security-incident scenarios — **DONE this phase**, see
      `docs/disaster-recovery-runbooks.md`
- [ ] Recurring drill cadence adopted operationally — **recommended**
      (§11); adoption is an operational decision outside this
      repository's ability to enforce
- [ ] `production-readiness-check.js` reports the managed-backup check
      as PASS, not NOT CONFIGURED — **NOT DONE**, by design, until the
      above is real

**Do not deploy real user funds to production until every unchecked
item above is either genuinely done or explicitly, knowingly accepted
as a risk by whoever owns that decision.**
