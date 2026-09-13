# VerdictVaut

VerdictVaut is a premium global markets platform — a dark, high-end financial
UI for trading YES/NO outcomes on real-world markets, backed by a server-side
authoritative ledger and real crypto deposits/withdrawals (sandbox/testnet in
this phase; production custody is not implemented yet).

This repository includes authentication, the ledger, the asset/network/
wallet model (deposit watchers, withdrawal confirmation, reconciliation —
see below), a price-time-priority matching engine with real,
collateral-backed complete-set minting (see
[Settlement collateralization](#settlement-collateralization-complete-set-minting)
below), market resolution/settlement, trading/wallet/admin frontends,
and role-guarded admin tooling, tested where practical. Production
custody integration is the main remaining piece — see
[Next recommended implementation steps](#next-recommended-implementation-steps).

## Repository layout

```
apps/
  web/    Next.js (App Router) frontend — dark theme foundation, no trading UI yet
  api/    NestJS backend — auth, users, markets, trading, ledger, wallet, admin
packages/
  shared-types/   Types/schemas shared between web and api (assets, order DTOs)
infra/
  docker-compose.yml   Local PostgreSQL for development
  backup.sh            Real pg_dump-based backup for the docker-compose Postgres
  restore.sh           Restores a backup/backup.sh dump into a new database
docs/
  database-backup-recovery.md         Backup/DR architecture, RPO/RTO status, restore test results
  deployment-architecture.md          Phase 16 — API/worker/web process split, deployment boundaries
  production-database-requirements.md Phase 16 — production Postgres version/TLS/pooling/migration requirements
  observability-and-alerting.md       Phase 16 — logs/metrics/health endpoints, defined alert conditions
  operations-runbook.md               Phase 16 — deploy/rollback/backup/restore/incident procedures
```

### Backend module boundaries (`apps/api/src`)

- **auth** — registration/login, JWT access + refresh tokens, refresh rotation.
- **users** — user profile lookups.
- **markets** — market/category CRUD and discovery reads.
- **trading** — order intake, cancellation, and a real price-time-priority
  matching engine (`PriceTimePriorityMatchingEngine`) producing `Fill`
  rows. `BUY` orders that find no matching resting inventory fall back to
  complementary complete-set minting against the market's other outcome
  (`PriceTimePriorityCompleteSetMintEngine`) — see
  [Settlement collateralization](#settlement-collateralization-complete-set-minting).
- **ledger** — the single authoritative path (`LedgerService.postEntry`) for
  every balance mutation. Runs at `SERIALIZABLE` isolation; never allows a
  balance to go negative; every entry is immutable and auditable.
- **wallet** — asset/network model, dedicated per-user deposit addresses,
  the deposit crediting path, the withdrawal state machine, the
  `WithdrawalExecutor` abstraction (`ManualBroadcastExecutor` for sandbox,
  `ProductionCustodyExecutor` as an unimplemented, fail-closed placeholder),
  per-chain deposit-watcher/withdrawal-confirmation background workers, a
  cursor-adjacent reconciliation framework, and an independent
  rescan-and-diff reconciliation pass that never trusts the watcher
  cursor (Phase 12A) — see
  [Blockchain watcher & reconciliation architecture](#blockchain-watcher--reconciliation-architecture) below.
- **admin** — role-guarded configuration and operational endpoints
  (asset/network management, address provisioning, withdrawal
  approval/broadcast, reconciliation trigger, audit log reads). Every
  mutating admin action writes an `AuditLog` row.

## Prerequisites

- Node.js 20+ (developed against Node 24)
- npm 10+
- PostgreSQL 16 (via Docker, or a local install)

## 1. Install dependencies

From the repository root (this is an npm workspaces monorepo — one install
covers `apps/*` and `packages/*`):

```bash
npm install
```

## 2. Configure environment variables

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Edit `apps/api/.env` and set real values for `JWT_ACCESS_SECRET` and
`JWT_REFRESH_SECRET` (e.g. `openssl rand -hex 32` for each). See
[Environment variables](#environment-variables) below for the full list.

## 3. Run PostgreSQL

Using the provided Docker Compose file:

```bash
docker compose -f infra/docker-compose.yml up -d
```

This starts Postgres on `localhost:5432` with the credentials already
matching `apps/api/.env.example`'s default `DATABASE_URL`. If you're running
your own Postgres instance instead, just point `DATABASE_URL` at it.

## 4. Run database migrations

```bash
npm run prisma:generate
npm run prisma:migrate       # applies migrations against DATABASE_URL, prompts to create one on first run
```

This repository ships with an initial migration
(`apps/api/prisma/migrations/`) generated from the schema in
`apps/api/prisma/schema.prisma`. To seed reference data (the six supported
assets, their sandbox/mainnet networks, and the asset↔network pairs — **not**
any balances, deposits, or transactions):

```bash
npm run --workspace apps/api prisma:generate -- # ensures client is current
npx prisma db seed --schema apps/api/prisma/schema.prisma
```

(or `cd apps/api && npx prisma db seed`).

## 5. Start the development servers

In separate terminals:

```bash
npm run dev:api   # NestJS API on http://localhost:4000
npm run dev:web   # Next.js frontend on http://localhost:3000
```

## 6. Run tests

```bash
npm run test          # backend unit tests (ledger/accounting primitives, etc.)
npm run test:cov       # with coverage
```

The ledger tests (`apps/api/src/ledger/*.spec.ts`) are the most important —
they cover the balance arithmetic and the insufficient-balance guard using a
mocked Prisma client, so they run without a live database. Wiring
integration tests against a real Postgres instance is a good next addition.

## Environment variables

### `apps/api/.env`

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` / `test` / `production` |
| `APP_ENVIRONMENT` | `sandbox` (only supported value right now) or `production` (rejected at boot — production custody isn't implemented) |
| `PORT` | API port, default `4000` |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | Random secrets for signing tokens — generate with `openssl rand -hex 32`, never commit real values |
| `JWT_ACCESS_TTL` / `JWT_REFRESH_TTL` | Token lifetimes (e.g. `15m`, `7d`) |
| `ENABLE_DEV_FUNDING_TOOLS` | Must stay `false` outside local development; gates any future dev-only funding convenience endpoints (none exist yet) |
| `BITCOIN_TESTNET_RPC_URL`, `ETHEREUM_SEPOLIA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `SOLANA_DEVNET_RPC_URL`, `XRPL_TESTNET_RPC_URL` | Read-only RPC/explorer endpoints for the chain adapters/watchers. Optional — each has a working public sandbox/testnet default (see `rpc-config.service.ts`); set these to point at a credentialed provider (Infura/Alchemy/QuickNode/etc.) instead for anything beyond light development traffic |
| `CHAIN_WATCHER_ENABLED` / `CHAIN_WATCHER_POLL_INTERVAL_MS` | Deposit-scanning background worker — `false` by default so importing the module (including every test run) never makes outbound network calls on its own |
| `WITHDRAWAL_WATCHER_ENABLED` / `WITHDRAWAL_WATCHER_POLL_INTERVAL_MS` | Withdrawal-confirmation background worker — same off-by-default reasoning |
| `EMAIL_PROVIDER` | `none` (default, no real email ever sent) or `postmark` — see [`docs/email-delivery.md`](docs/email-delivery.md) |
| `POSTMARK_SERVER_TOKEN` / `EMAIL_FROM_ADDRESS` / `EMAIL_BASE_URL` | Required only when `EMAIL_PROVIDER=postmark`; production refuses to boot without all three |

### `apps/web/.env`

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the API, e.g. `http://localhost:4000` |
| `NEXT_PUBLIC_APP_ENVIRONMENT` | Mirrors the backend's sandbox/production flag for UI messaging |

Never commit `.env` files — only `.env.example` files belong in git. No
private keys or signing credentials belong in any `.env` file in this repo;
the wallet/custody design intentionally keeps them out of the application
database and out of the frontend entirely (see `apps/api/src/wallet`).

## Blockchain watcher & reconciliation architecture

Live since Phase 5 (deposit watcher/adapters), Phase 9 (withdrawal
confirmation watcher), and hardened in Phase 10 (retry/backoff, worker
leases, reorg/cursor safety, reconciliation severity). All of this is
**off by default** (see the watcher env vars above) — no test run or
freshly-started instance makes an outbound chain call on its own.

**Supported chains/networks** — Bitcoin (testnet, Esplora REST), EVM
(Ethereum Sepolia + Base Sepolia, plain JSON-RPC — native transfers and
ERC-20), Solana (devnet, JSON-RPC — native SOL and SPL tokens, including
Address-Lookup-Table-resolved accounts), XRPL (testnet, `rippled`
JSON-RPC — native XRP with destination-tag support). Each has its own
adapter (`apps/api/src/wallet/chain-adapters/<chain>/`) — deliberately
NOT a lowest-common-denominator abstraction, since UTXO/account/
instruction-based chains have materially different transaction models.

**Scan cursors & reorg safety** (`BlockchainWatchCursor`, one row per
asset/network) — the EVM adapter's cursor is a real resume point (a block
number) that is bounded by `INITIAL_BACKFILL_BLOCKS` on first scan and
`LOG_SCAN_MAX_BLOCK_RANGE`/`NATIVE_SCAN_MAX_BLOCK_RANGE` per poll, and
never advances past `chainTip - REORG_SAFETY_MARGIN_BLOCKS` — so a
shallow reorg near the tip is simply re-scanned on the next poll rather
than silently skipped, and the cursor itself can never regress. Bitcoin/
Solana/XRP re-derive their "recent window" fresh from live chain state on
every poll instead (their cursor field is informational only), which
reflects a reorg the same way. No adapter ever reverses a CREDITED
deposit automatically — a transaction that disappears/fails after being
observed is a reconciliation discrepancy for a SUPER_ADMIN to act on
explicitly, never a silent balance mutation.

**Reorg safety analysis (Phase 13 remediation)** — a deliberate review
of the existing design, not a new mechanism (the design already handles
this correctly):
- Confirmation depth (`AssetNetwork.minConfirmations`, configurable per
  asset/network, never hardcoded) is the primary defense, and the right
  depth is chain-specific, not one-size-fits-all: XRPL's consensus
  protocol gives a validated ledger BFT-style finality (not Bitcoin-style
  probabilistic PoW finality), so `minConfirmations=1` for XRP is
  correct, not thin. Solana's seeded value (32) matches Solana's own
  `finalized` commitment level. Bitcoin's SEEDED value (2) is a
  **testnet-only** setting — a real mainnet Bitcoin deployment MUST
  raise this to a materially higher value (6 is the long-standing
  industry norm) before accepting real value; this is a launch
  CONFIGURATION requirement, not a code defect, since the field is
  already fully configurable.
- If a reorg still invalidates an already-CREDITED deposit deeper than
  the configured confirmation depth (rare, but not impossible): nothing
  in this codebase auto-reverses it. Detection is
  `IndependentReconciliationService.checkRecentCreditedDepositsHaveChainEvidence`
  — a CREDITED deposit a fresh, cursor-independent rescan can no longer
  find on chain raises a CRITICAL `internal_deposit_missing_chain_evidence`
  discrepancy for a SUPER_ADMIN to investigate. This is currently
  SUPER_ADMIN-triggered on demand
  (`POST /admin/reconciliation/:assetNetworkId/independent-rescan`), not
  scheduled — an operational runbook should run it periodically until a
  scheduler is added (see Next recommended implementation steps).
- Explicit non-goal, deliberately: automatically reversing a CREDITED
  deposit (debiting a user who may have already traded or withdrawn
  against it) is a broader accounting problem than reorg detection
  alone — it requires a policy for a user who no longer has the funds,
  which is out of scope here. Left as an explicit, documented blocker
  rather than an invented reversal mechanism.

**Worker concurrency** — `BlockchainWatchCursor` also carries a
CAS-acquired scan lease (`lockedAt`/`lockedBy`, reclaimed if stale after
5 minutes) so multiple concurrently-running API instances never
duplicate-scan the same asset/network. Independently, actual deposit
crediting is idempotency-safe at the database level regardless (unique
constraint on `(assetNetworkId, txHash, eventIndex)` plus a ledger
idempotency key) — the lease prevents wasted duplicate work, it is not
the only thing standing between concurrent workers and a duplicate
credit.

**RPC failure handling** — every low-level chain call
(`fetchJson`/`fetchJsonRpc`/`callRippled`) is wrapped in bounded
exponential-backoff-with-jitter retries (`retry.util.ts`, default 4
attempts). A provider failure is never turned into "no deposits found":
a scan that doesn't complete successfully never advances its cursor.

**Withdrawal confirmation** — `WithdrawalWatcherService` polls
BROADCAST/CONFIRMING withdrawals and verifies real chain evidence before
ever calling `WithdrawalsService.recordConfirmation()`. A transaction the
chain reports as reverted/failed (an EVM revert, an XRPL `tec*` result, a
Solana `err`) moves the withdrawal to FAILED and releases its reservation
— it is never silently ignored, and a withdrawal is never marked
confirmed on an admin's word alone.

**Reconciliation** (`ReconciliationService`, `POST
/admin/reconciliation/:assetNetworkId/run`) compares, per asset/network:
real on-chain address balances against internally-CREDITED deposit sums;
CREDITED deposits against their ledger-transaction reference in both
directions; and watcher cursor staleness. Every finding carries a
deterministic `INFO`/`WARNING`/`CRITICAL` severity and a stable `type`
slug — see `ReconciliationDiscrepancy` — and reconciliation only ever
records findings, never mutates a balance/deposit/withdrawal to "fix"
one. `WithdrawalsService.reconcile()` (per-withdrawal,
`POST /admin/withdrawals/:id/reconcile`) is the withdrawal-side
counterpart, checking both the "claims broadcast but chain shows nothing"
and "reservation already released but chain shows real activity"
directions, plus destination/amount mismatches where the chain
unambiguously reports a single recipient (EVM/XRP).

**Operational visibility** (`GET /admin/watchers`, read-only for ADMIN
and SUPER_ADMIN) — every asset/network's current cursor, scan lease
state, and last success/error, so an operator can see watcher health
without reading server logs.

**Independent reconciliation** (Phase 12A —
`IndependentReconciliationService`, `POST
/admin/reconciliation/:assetNetworkId/independent-rescan`, SUPER_ADMIN
only) is a SEPARATE rescan-and-diff pass that deliberately never reads
`BlockchainWatchCursor` — its resume point is either an explicit
SUPER_ADMIN-supplied `fromPointer` or `null` (each chain adapter's own
bounded default backfill), so a bug or manipulation of the persisted
watcher cursor can never hide a real discrepancy from it. It reuses the
same per-chain adapters (never a second chain-reading implementation)
to compare freshly-observed chain events against internal
Deposit/Withdrawal records in both directions, and against
`CustodyProvider.getTransactionStatus` for in-flight withdrawals.
Findings become first-class `ReconciliationDiscrepancy` rows (`GET
/admin/reconciliation/discrepancies`, `OPEN → ACKNOWLEDGED →
RESOLVED/FALSE_POSITIVE`, SUPER_ADMIN-resolved) — this service NEVER
auto-credits, auto-debits, or otherwise mutates a balance/deposit/
withdrawal; every finding is purely observational.

**Withdrawal destination validation** (Phase 13 remediation —
`destination-address.validator.ts`) is FORMAT + CHECKSUM validation
only, never on-chain ownership verification — an important distinction:
- Bitcoin (legacy 1.../3... via Base58Check, bech32/bech32m native
  segwit v0-v16 including taproot) and XRP classic addresses (Base58Check
  with the XRPL alphabet) now verify a REAL cryptographic checksum
  (`address-checksums/base58.util.ts`, `bech32.util.ts` — both built on
  Node's native `crypto`, no new dependency), not just a shape-matching
  regex. Solana addresses are verified to decode to exactly 32 bytes
  (the real ed25519 public key length) — Solana itself has no checksum
  convention to verify.
- EVM EIP-55 mixed-case checksum verification is DEFERRED, deliberately
  documented in `assertValidEvmAddress`'s own comment: it requires
  Keccak-256, which is NOT the same algorithm as the SHA3-256 Node's
  built-in `crypto` provides (different padding — using SHA3-256 would
  silently compute the wrong checksum), and no Keccak dependency exists
  in this repo today. A correctly- or incorrectly-checksummed mixed-case
  EVM address is accepted identically (format-only) until a real
  decision is made to add one.
- None of this proves the address is actually OWNED by anyone in
  particular, or that a chain adapter has ever observed activity on it
  — that would be on-chain ownership verification, which no network
  performs here (destination cross-checking against chain-reported
  broadcast data, for an ALREADY-SENT withdrawal, is a separate,
  narrower check — see `WithdrawalsService.reconcile()`).

**Other known limitations, explicitly not implemented**: no distributed
lock beyond the DB-row CAS lease described above (no new infra
dependency introduced); no configurable per-network RPC timeout (fixed
at 10s); no scheduled/automatic independent-reconciliation rescan (see
the reorg-safety analysis above — currently SUPER_ADMIN-triggered on
demand). See the Phase 10/12A/13 final reports for the full list.

## Settlement collateralization (complete-set minting)

Phase 12A replaced the `SETTLEMENT_POOL` accounting shortcut (a house
account that funded every winning payout directly, with no real
collateral behind it — see its own docblock in `schema.prisma`, kept for
historical/audit purposes but no longer written to by any code path)
with real, provable collateralization.

**The mechanism**: a `BUY` order on one outcome and a complementary
resting `BUY` order on the market's OTHER outcome (binary markets only —
see below), whose prices sum to exactly `1`, mint a **complete set**:
`quantity` new shares of EACH outcome are created, and exactly
`quantity` units of settlement currency are locked in the market's own
collateral `LedgerAccount` (`LedgerAccountOwnerType.MARKET`, one real
account per market, funded by real cash debited from both buyers — see
`CompleteSetMint`, `ExecutionCoordinator.applyMintExecution`, and the
new `LedgerTransactionType.MINT`). This is the ONLY mechanism that ever
increases the total float of an outcome's shares; ordinary same-outcome
`BUY`/`SELL` matching remains an unchanged pure transfer between
existing holders, and same-outcome matching is always attempted FIRST —
minting only ever fills the "no seller exists yet" gap.

Because minting always locks exactly `1` unit of currency per unit of
quantity created (`priceA + priceB = 1`, enforced by
`complete_set_mints_price_sum_check`), and transfers never change the
total float, a market's collateral account balance always exactly
equals the total shares ever minted for it — which is exactly enough to
fund every winning payout at settlement (`SettlementService` now debits
the resolving market's OWN collateral account, never a house account)
and reach precisely zero once every position is settled, with no
leftover and no shortfall. Restricted to exactly-binary (2-outcome)
markets — a 3+-outcome market's "complete set" would require an atomic
N-way match this pairwise engine doesn't attempt; such markets'
`SELL` orders still require pre-existing inventory, unchanged (this
platform's actual markets are binary YES/NO today).

## Independent blockchain reconciliation

See [Blockchain watcher & reconciliation architecture](#blockchain-watcher--reconciliation-architecture)
above — Phase 12A's independent rescan-and-diff pass is documented there
alongside the pre-existing cursor-adjacent checks it deliberately never
trusts.

## Backup & disaster recovery

See [`docs/database-backup-recovery.md`](docs/database-backup-recovery.md)
for the full, honest backup/recovery architecture — what real tooling
exists today (`infra/backup.sh`/`restore.sh`,
`apps/api/scripts/backup-restore-drill.js`, an ACTUAL restore test that
was run and passed), what a real production deployment still requires
(a chosen managed-provider/self-hosted strategy, WAL archiving for true
PITR, off-site encrypted storage, explicit RPO/RTO targets), and the
reusable financial integrity checks (`apps/api/scripts/financial-integrity-checks.js`,
`npm run check:integrity`) usable during development, after a restore,
or during an incident.

## Deployment & operations (Phase 16)

The API, background blockchain workers, and web frontend are three
independently deployable processes/images — see
[`docs/deployment-architecture.md`](docs/deployment-architecture.md)
for the process split, the boundary that stops workers from
accidentally starting inside the HTTP API process, and why no new
cross-instance locking was needed for withdrawal workers. See also:
[`docs/production-database-requirements.md`](docs/production-database-requirements.md)
(version/TLS/connection-pooling requirements and migration safety),
[`docs/observability-and-alerting.md`](docs/observability-and-alerting.md)
(what's loggable/measurable today and the alert conditions defined
against it), and
[`docs/operations-runbook.md`](docs/operations-runbook.md) (deploy,
rollback, backup/restore, worker recovery, incident response —
each procedure marked READY FOR IMPLEMENTATION or VERIFIED). None of
this has been exercised against a real orchestrator or Docker daemon
(unavailable in every environment this repo has been developed in so
far) — `.github/workflows/ci.yml`'s `docker-build` job is where that
actually gets validated, on GitHub's own runners.

## Next recommended implementation steps

The matching engine, market resolution/settlement, order/withdrawal risk
controls, `SerializableTransactionRunner`-based conflict retry, the
trading/wallet/admin frontends, and the blockchain watcher/reconciliation
work described above are all implemented (this list previously described
them as pending — that's now out of date and has been corrected). What
remains, roughly in priority order:

1. **Production custody** — select a real custody provider (e.g.
   Fireblocks/Turnkey) or a KMS/HSM-backed signer and implement
   `ProductionCustodyExecutor` + a real signing/broadcast path against it,
   gated by `WithdrawalExecutionConfig` per asset/network. Until this
   exists, `APP_ENVIRONMENT=production` is refused at boot and
   `WithdrawalExecutorFactory` independently fails closed rather than
   falling back to `ManualBroadcastExecutor` — no other code should need
   to change once a provider is chosen.
2. **Fiat on/off-ramp** — genuinely out of scope until a specific
   provider/compliance posture is chosen; not modeled anywhere today.
3. **KYC/AML/sanctions integration** — `WithdrawalComplianceGate` is a
   real, exercised integration seam (`DeferredComplianceGate` is its only
   implementation today, always returning `DEFERRED`) for whenever a real
   provider is selected.
4. **Deeper reconciliation, remaining gap** — the independent
   rescan-and-diff pass (Phase 12A) is now implemented; Bitcoin/Solana
   withdrawal destination verification is still explicitly not (no
   single unambiguous on-chain recipient to compare against without
   deeper transaction analysis) — see
   [Blockchain watcher & reconciliation architecture](#blockchain-watcher--reconciliation-architecture)'s
   "known limitations" note.
5. **Load testing** — scan batch sizes, DB query patterns, and RPC
   request counts are bounded by design (see above), but have not been
   load-tested against realistic production traffic volumes.
6. **Production-grade backup infrastructure** — Phase 12A documents the
   full architecture and ships real, tested tooling (`infra/backup.sh`,
   an actual passing restore drill — see
   [Backup & disaster recovery](#backup--disaster-recovery)), but a
   managed-provider or self-hosted HA strategy, WAL archiving for true
   point-in-time recovery, off-site encrypted storage, and explicit
   RPO/RTO targets are all still undecided/unimplemented — see
   `docs/database-backup-recovery.md` §7 for the exact prerequisite
   list. **Do not hold real funds in production until this is resolved.**
7. **Real Docker/orchestrator verification** — Phase 16 split the API
   and background workers into independently deployable Dockerfile
   targets (`docs/deployment-architecture.md`) and CI now builds both on
   every push (`.github/workflows/ci.yml`'s `docker-build` job), but no
   session that authored this code has ever had a working Docker daemon
   to run either image, let alone deploy two real replicas against a
   real Postgres and watch the worker actually process a sandbox
   deposit/withdrawal end to end. Do this before trusting the worker
   split in a real deployment.
