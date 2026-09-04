# VerdictVaut

VerdictVaut is a premium global markets platform — a dark, high-end financial
UI for trading YES/NO outcomes on real-world markets, backed by a server-side
authoritative ledger and real crypto deposits/withdrawals (sandbox/testnet in
this phase; production custody is not implemented yet).

This repository is a monorepo foundation: authentication, the ledger, the
asset/network/wallet model, and admin tooling are scaffolded and tested where
practical. Market discovery UI and a matching engine are **not** built yet —
see [Next steps](#next-steps).

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
  deposit crediting path, the withdrawal state machine, and the
  `WithdrawalExecutor` abstraction (`ManualBroadcastExecutor` for sandbox,
  `ProductionCustodyExecutor` as an unimplemented placeholder).
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
| `BITCOIN_TESTNET_RPC_URL`, `ETHEREUM_SEPOLIA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`, `SOLANA_DEVNET_RPC_URL`, `XRPL_TESTNET_RPC_URL` | Read-only RPC/explorer endpoints for the chain watcher/reconciliation jobs — **not implemented yet**, safe to leave blank until that work starts |

### `apps/web/.env`

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the API, e.g. `http://localhost:4000` |
| `NEXT_PUBLIC_APP_ENVIRONMENT` | Mirrors the backend's sandbox/production flag for UI messaging |

Never commit `.env` files — only `.env.example` files belong in git. No
private keys or signing credentials belong in any `.env` file in this repo;
the wallet/custody design intentionally keeps them out of the application
database and out of the frontend entirely (see `apps/api/src/wallet`).

## Next recommended implementation steps

Roughly in priority order:

1. **Chain watchers** — implement a real `CustodyProvider` per asset/network
   (RPC/explorer polling for Bitcoin testnet, Sepolia, Base Sepolia, Solana
   devnet, XRPL testnet) that feeds `DepositsService.recordObservedTransaction`
   and the withdrawal confirmation path. Nothing credits or confirms
   anything until this exists — that's deliberate.
2. **Matching engine** — price-time-priority order matching in `trading/`,
   producing `Fill` rows and driving `Position` updates and trade-related
   ledger entries (with a balance hold placed at order submission, released
   or converted to a fill on match).
3. **Market resolution/settlement** — an admin flow that resolves a market's
   outcome and pays out `Settlement`-driven ledger credits to position
   holders.
4. **Risk controls** — enforce `RiskLimit` rows (max position size, daily
   withdrawal caps, KYC tiers) in the trading and withdrawal paths; they're
   modeled in the schema but not yet checked anywhere.
5. **Serialization-conflict retry** — wrap `LedgerService.postEntry` callers
   with a retry-on-serialization-failure helper for production traffic.
6. **Frontend build-out** — markets discovery/search, market detail with
   pricing charts, the YES/NO trading panel, portfolio/performance views,
   and the wallet UI (deposit address display, withdrawal request flow),
   all reading from the API — never computing balances client-side.
7. **Admin UI** — a real dashboard over the existing `/admin/*` endpoints
   (asset/network config, address provisioning, withdrawal review/broadcast,
   reconciliation, audit log).
8. **Production custody** — once ready to leave the testing phase, implement
   `ProductionCustodyExecutor` and a real `CustodyProvider` against a chosen
   custody provider (e.g. Fireblocks/Turnkey) or a KMS/HSM-backed signer,
   gated by `WithdrawalExecutionConfig` per asset/network — no other code
   should need to change.
