# VerdictVaut

VerdictVaut is a premium global markets platform — a dark, high-end financial
UI for trading YES/NO outcomes on real-world markets, backed by a server-side
authoritative ledger and real crypto deposits/withdrawals (sandbox/testnet in
this phase; production custody is not implemented yet).

This repository includes authentication, the ledger, the asset/network/
wallet model (deposit watchers, withdrawal confirmation, reconciliation —
see below), a price-time-priority matching engine, market resolution/
settlement, trading/wallet/admin frontends, and role-guarded admin
tooling, tested where practical. Production custody integration is the
main remaining piece — see [Next recommended implementation steps](#next-recommended-implementation-steps).

## Repository layout

```
apps/
  web/    Next.js (App Router) frontend — dark theme foundation, no trading UI yet
  api/    NestJS backend — auth, users, markets, trading, ledger, wallet, admin
packages/
  shared-types/   Types/schemas shared between web and api (assets, order DTOs)
infra/
  docker-compose.yml   Local PostgreSQL for development
```

### Backend module boundaries (`apps/api/src`)

- **auth** — registration/login, JWT access + refresh tokens, refresh rotation.
- **users** — user profile lookups.
- **markets** — market/category CRUD and discovery reads.
- **trading** — order intake and cancellation, positions read. No matching
  engine yet (see Next steps) — orders are validated and persisted, not
  matched or filled.
- **ledger** — the single authoritative path (`LedgerService.postEntry`) for
  every balance mutation. Runs at `SERIALIZABLE` isolation; never allows a
  balance to go negative; every entry is immutable and auditable.
- **wallet** — asset/network model, dedicated per-user deposit addresses,
  the deposit crediting path, the withdrawal state machine, the
  `WithdrawalExecutor` abstraction (`ManualBroadcastExecutor` for sandbox,
  `ProductionCustodyExecutor` as an unimplemented, fail-closed placeholder),
  per-chain deposit-watcher/withdrawal-confirmation background workers, and
  a reconciliation framework comparing internal state against live chain
  data — see [Blockchain watcher & reconciliation architecture](#blockchain-watcher--reconciliation-architecture) below.
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

**Known limitations, explicitly not implemented**: no independent
"rescan the chain and diff against internal deposit records" check (the
watcher's own idempotent detection is the one deposit-detection system —
see Worker concurrency above for why a second one isn't necessary for
correctness); destination verification for Bitcoin/Solana withdrawals
(no single unambiguous on-chain recipient to compare against without
deeper transaction analysis); no distributed lock beyond the DB-row CAS
lease described above (no new infra dependency introduced); no
configurable per-network RPC timeout (fixed at 10s). See the Phase 10
final report for the full list.

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
4. **Deeper reconciliation** — an independent "rescan the chain and diff
   against internal deposit records" pass, and Bitcoin/Solana withdrawal
   destination verification, are explicitly not implemented — see
   [Blockchain watcher & reconciliation architecture](#blockchain-watcher--reconciliation-architecture)'s
   own "known limitations" note for why and what a real implementation
   would need.
5. **Load testing** — scan batch sizes, DB query patterns, and RPC
   request counts are bounded by design (see above), but have not been
   load-tested against realistic production traffic volumes.
