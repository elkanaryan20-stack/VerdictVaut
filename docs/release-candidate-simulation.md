# Release-Candidate Simulation — Phase 39

`npm run build -w apps/api && npm run rc:simulate -w apps/api` (default two
clean-room runs; `-- --runs 1 --keep` keeps the logs/data dir).

## What it runs

Every run starts from an **empty** throwaway PostgreSQL (fresh data dir and
port), applies every migration with `prisma migrate deploy`, runs the
deterministic reference seed, then starts the **compiled** API
(`dist/main.js`) and **worker** (`dist/worker.main.js`) as separate OS
processes with their real configuration surface (trust proxy = 1, Noop email,
sandbox custody/compliance, chain + withdrawal watchers and reconciliation
scheduler enabled in the worker only).

Chain access: a local, deterministic EVM JSON-RPC node stands in for
Ethereum Sepolia (the only chain with end-to-end chain fixtures). Every other
network's RPC URL points at an unreachable local port — no public blockchain
is ever contacted, and those watchers/rescans must fail closed.

Funding comes **only** from simulated on-chain USDC transfers that the real
worker observes and credits — no ledger fixtures — so the repository's
`financial-integrity-checks.js` must pass with no exceptions.

Scenarios (all over real HTTP, each actor with its own `X-Forwarded-For`
client IP as behind the ALB): configuration refusals; registration →
verification → login → refresh rotation → reuse detection → logout; roles
(SUPER_ADMIN via `bootstrap-super-admin.js`, ADMIN via DB fixture — no
role-management API exists by design); deposits (confirmation gating,
wrong-contract noise, replay, owner scoping); market lifecycle incl. the
category bootstrap; trading (mint, price-time priority, partial fill,
cancel, idempotency, Phase 37 precision); close → resolve → settlement;
withdrawals (approve/broadcast/confirm, amount mismatch fails closed,
unknown hash → declare ambiguous → resolve, reject, cancel, redaction);
reconciliation (rescan de-duplication, unreachable provider = ERROR);
scheduler + worker restart; admin/audit; log secret scan; direct-SQL
financial invariants; integrity script.

## Environment matrix

| Concern | Local dev | Local production-like (this simulation) | CI | Staging | Production |
|---|---|---|---|---|---|
| API / worker | `nest start` (watch) | compiled `dist`, separate processes | build + unit + integration (embedded PG) | ECS (Terraform) — REQUIRES EXTERNAL PROVISIONING | same — boot is BLOCKED by design |
| Database | local / embedded PG | fresh embedded PG per run | embedded PG | RDS — REQUIRES PROVISIONING; instance class undecided | same |
| Secrets | `.env` | random per run | fake CI values | Secrets Manager refs (Terraform) — REQUIRES PROVISIONING | same |
| Proxy (`TRUST_PROXY_HOPS`) | 0 | 1 (X-Forwarded-For per actor) | n/a | 1 (Terraform) — CONFIGURED | 1 — CONFIGURED |
| Email | Noop | Noop | Noop | Postmark — CONFIGURED, needs real token/domain | Postmark required at boot |
| Chain providers | public testnet defaults | local fake EVM node; others unreachable | fakes in tests | real RPC — REQUIRES PROVISIONING | same |
| Custody | ManualBroadcastExecutor | ManualBroadcastExecutor | mocks | Manual / Fireblocks sandbox (unverified live) | ProductionCustodyExecutor fails closed — NOT IMPLEMENTED |
| Compliance | Deferred | Deferred | mocks | Deferred / Elliptic sandbox (EVM only, unverified live) | Deferred forced — NOT IMPLEMENTED |
| Reconciliation scheduler | off | on (worker) | tests | CONFIGURED (env), cadence undecided | same |
| Logs / metrics | JSON stdout | JSON stdout (scanned for secrets) | n/a | CloudWatch (Terraform) — REQUIRES PROVISIONING | same |

## Not covered (stated, not assumed)

- Browser/UI interaction (no browser automation exists; the web build is
  served and every route returns 200, which proves serving, not behaviour).
- Bitcoin/Solana/XRPL end-to-end deposits/withdrawals (adapter unit and
  integration fixtures only; no local node for those chains).
- Docker image runtime and Terraform validate (binaries unavailable locally;
  both run in CI).
- Any live provider (custody, compliance, email, RPC).
