# Fireblocks Sandbox Smoke Test — Operator Checklist

Phase 14B.1. This is the operational checklist for the ONE thing Phase
14B itself could not do: prove `FireblocksCustodyAdapter` actually works
against a real Fireblocks sandbox account, not just against mocked HTTP
in this repo's own test suite.

**A passing unit/integration test suite is NOT a live Fireblocks
verification.** Every test in `apps/api/src/wallet/executors/fireblocks/`
and `apps/api/test/integration/fireblocks-webhook.integration-spec.ts`
proves this codebase's OWN request-construction and response-
interpretation logic is internally correct against a *simulated*
response. None of them prove the real `sandbox-api.fireblocks.io` API
actually accepts the request, uses the field names/enum values this
adapter assumes, or returns what the adapter expects. **Only a real,
successful sandbox operation — producing a genuine provider reference —
does that.** See `provider-capability-matrix.ts`'s `liveVerified` field,
which stays `false` for every row until one does.

This checklist assumes you have real access to a Fireblocks sandbox
workspace. It never uses production credentials, never contacts a
production endpoint, and never moves real funds.

---

## PRE-FLIGHT

Run `node scripts/staging-preflight-check.js` (read-only; prints
`PASS`/`WARN`/`FAIL` for each item, never a secret value) and confirm:

- [ ] `APP_ENVIRONMENT=sandbox` (not `production`, not unset in a real
      deployment — explicit is better than the default).
- [ ] `DATABASE_URL` is set and the database is reachable.
- [ ] All migrations on disk are applied (`npx prisma migrate deploy`
      if not — see "Staging database setup" below).
- [ ] A real Fireblocks **sandbox** account exists and you have console
      access to it.
- [ ] Real sandbox credentials (API key + RSA private key) are
      available to you, but **not yet** pasted into any file this
      repository tracks.
- [ ] No production Fireblocks credentials are loaded into this
      process's environment or into any `CustodyProviderConfig` row
      this environment will use.
- [ ] SUPER_ADMIN access to a running VerdictVaut API instance pointed
      at the staging database above.
- [ ] You have read `docs/provider-integration.md` §3 and §4 and
      understand which parts of the Fireblocks request shape are
      VERIFIED vs. UNVERIFIED for the asset/network you intend to test.

### Staging database setup (if you don't already have one running)

```bash
# 1. Start Postgres (local Docker) — or point DATABASE_URL at any
#    reachable staging Postgres instance you already run.
docker compose -f infra/docker-compose.yml up -d

# 2. Point DATABASE_URL at it (apps/api/.env, NOT .env.example)
#    DATABASE_URL="postgresql://verdictvaut:verdictvaut@localhost:5432/verdictvaut?schema=public"

# 3. Apply migrations
cd apps/api
npx prisma generate
npx prisma migrate deploy

# 4. Seed reference data (assets/networks/asset-network pairs — no
#    balances, deposits, or transactions)
npx prisma db seed

# 5. Verify schema + connectivity
npx prisma migrate status          # should report "Database schema is up to date"
node scripts/staging-preflight-check.js
```

If Docker/Postgres is not available to you, **do not fabricate a
database or fake its state** — stop here and provision one first (a
local install, a cloud free tier, or your team's existing staging
Postgres all work equally well; nothing about this checklist requires
any specific hosting choice).

### Configure the Fireblocks sandbox provider

Full parameter reference: `docs/provider-integration.md` §10. Summary,
as SUPER_ADMIN:

1. Set `FIREBLOCKS_SANDBOX_CREDENTIALS` in your own untracked
   `.env`/secret manager — a JSON string
   `{"apiKey": "...", "privateKey": "-----BEGIN PRIVATE KEY-----..."}`
   copied from your real Fireblocks sandbox console. **Never** commit
   this value; `apps/api/.env.example` only documents the variable
   NAME.
2. `POST /admin/custody/providers` —
   `{providerName: "Fireblocks", environment: "SANDBOX", apiBaseUrl: "https://sandbox-api.fireblocks.io/v1", credentialsSecretRef: "env:FIREBLOCKS_SANDBOX_CREDENTIALS", vaultOrAccountRef: "<your real vault account id, from the Fireblocks console>"}`.
3. `POST /admin/custody/providers/:id/enable`.
4. **Verified provider asset identifier** — log into the real
   Fireblocks sandbox console yourself and copy the exact `assetId`
   string it uses for the asset/network you intend to test (e.g.
   whatever it calls Sepolia ETH). **Do not guess this value** — the
   adapter has no fallback and `FireblocksCustodyAdapter` explicitly
   refuses to execute without one precisely because this string was
   never verified from accessible documentation.
5. **Verified provider network identifier** — confirm the same asset
   maps to the network family you expect (EVM/Bitcoin/Solana — **not**
   XRPL; see "Known capability gaps" below).
6. `POST /admin/custody/execution-config` —
   `{assetNetworkId: "<id>", environment: "SANDBOX", executorType: "PRODUCTION_CUSTODY", custodyProviderConfigId: "<id from step 2>", providerAssetId: "<the value verified in step 4>"}`.
7. Webhook (optional but recommended for a realistic test): set
   `FIREBLOCKS_WEBHOOK_PUBLIC_KEY` to Fireblocks' own published webhook
   verification public key, then re-run step 2's `POST` (or a
   follow-up update) with `webhookSecretRef: "env:FIREBLOCKS_WEBHOOK_PUBLIC_KEY"`.
   Expose `POST /webhooks/fireblocks` to Fireblocks' sandbox delivery
   (a tunnel like ngrok if testing from a machine without a public
   endpoint) if you want to exercise the webhook path rather than
   relying solely on `WithdrawalWatcherService`'s poll.

### Verify capability before you test

Call `GET /admin/providers/capability-matrix` (SUPER_ADMIN) and confirm
the row for your chosen network family:

| Network family | Fireblocks custody_execution |
|---|---|
| EVM (ETH/USDC/USDT) | `UNVERIFIED`, `liveVerified: false` |
| Bitcoin | `UNVERIFIED`, `liveVerified: false` |
| Solana | `UNVERIFIED`, `liveVerified: false` |
| XRPL | `UNSUPPORTED` — **do not attempt**; the adapter hard-refuses any destination-tag-bearing request |

`UNVERIFIED` here does not mean "broken" — it means the documented
field names/auth/status-enum are confirmed, but a few literal request
values were inferred, not independently re-confirmed. This smoke test's
entire purpose is closing that gap and flipping `liveVerified` to
`true` for the row you test, in a follow-up code change — **not**
during this operational phase.

---

## EXECUTION

Perform these in order. Stop and report (do not improvise a workaround)
if any step reveals a genuinely missing provider capability.

- [ ] **Configure provider** — completed above.
- [ ] **Configure withdrawal execution** — completed above.
- [ ] **Verify asset/network** — `GET` the `AssetNetwork` and confirm
      `isActive: true` and (for a non-native token) a real
      `contractAddress`.
- [ ] **Create a test withdrawal** — the smallest amount the asset
      permits, to a destination address YOU control and can confirm
      receipt at (never a throwaway/burn address for a real sandbox
      test — you want to be able to verify the funds actually moved).
- [ ] **Approve through the intended workflow** — `POST /admin/withdrawals/:id/approve`
      (SUPER_ADMIN) — this is what actually calls `FireblocksCustodyAdapter.execute()`.
- [ ] **Submit to Fireblocks sandbox** — happens automatically as part
      of approve() above. Record the raw HTTP status and response body
      (redacting nothing except credentials, which never appear in a
      Fireblocks response body anyway).
- [ ] **Capture the provider reference** — the real `id` Fireblocks
      returned, now stored as `Withdrawal.custodyReference`. Never
      write down a reference you did not see Fireblocks actually
      return.
- [ ] **Poll status / process webhook if supported** — either let
      `WithdrawalWatcherService` (if `WITHDRAWAL_WATCHER_ENABLED=true`)
      poll `checkStatus()`, or, if webhooks are configured, wait for a
      real delivery to `POST /webhooks/fireblocks`.
- [ ] **Verify tx hash — ONLY if genuinely returned** by Fireblocks
      once the transaction actually broadcasts. Do not proceed as if a
      tx hash exists before one does.
- [ ] **Verify withdrawal state** — `GET /admin/withdrawals/:id` shows
      the expected progression (`BROADCASTING` → `BROADCAST`/`PENDING_MANUAL_BROADCAST` → ... ).
- [ ] **Verify reservation** — the user's `FundReservation` for this
      withdrawal is `ACTIVE` until the withdrawal reaches a terminal
      state, then `RELEASED`/consumed appropriately — never released
      early.
- [ ] **Verify ledger effects** — no balance change until the
      withdrawal is genuinely confirmed/credited per the existing state
      machine (unchanged by this phase).
- [ ] **Run reconciliation** — `POST /admin/reconciliation/:assetNetworkId/independent-rescan`
      and confirm no discrepancy is produced for this withdrawal.

## FAILURE TESTS

Each of these should be attempted deliberately, in sandbox, with the
smallest possible amount/impact:

- [ ] **Duplicate execution** — attempt to approve the same withdrawal
      twice (e.g. two concurrent admin requests); confirm exactly one
      real Fireblocks submission occurs (the execution-lease CAS, plus
      `externalTxId` idempotency at Fireblocks' own end).
- [ ] **Timeout** — temporarily lower the configured `timeoutMs` on the
      `CustodyProviderConfig` to force a transport timeout; confirm the
      withdrawal lands in `EXECUTION_AMBIGUOUS`, never silently retried.
- [ ] **Ambiguous result** — a malformed/5xx response (can be forced by
      a deliberately wrong `apiBaseUrl` path for one call) should also
      produce `EXECUTION_AMBIGUOUS`, not a fabricated success or a
      silent failure.
- [ ] **Duplicate webhook** — if webhooks are configured, have
      Fireblocks (or your own signed replay of a captured payload)
      deliver the same event twice; confirm the second delivery is
      reported `"duplicate"` and produces no second state change.
- [ ] **Invalid webhook signature** — send an unsigned or wrongly-signed
      request to `POST /webhooks/fireblocks`; confirm a 401 and that
      `processWebhookPayload` is never reached.
- [ ] **Provider rejection** — if your sandbox account can produce a
      genuine `REJECTED`/`BLOCKED` status (e.g. via Fireblocks' own
      sandbox test-transaction tooling, never a fabricated payload),
      confirm the withdrawal fails and its reservation releases **only
      while pre-broadcast** — see `WithdrawalsService.failProviderRejectedSubmission()`'s
      own docblock. If the withdrawal has already broadcast, confirm a
      REJECTED report is instead refused and logged as an anomaly
      (`withdrawal.provider_rejection_after_broadcast_refused` in the
      audit log), never silently applied.
- [ ] **Provider/network mismatch** — attempt to link a `PRODUCTION`-
      flagged `CustodyProviderConfig` to this sandbox process (e.g. via
      a second, deliberately-mismatched config) and confirm
      `WithdrawalExecutorFactory`/`FireblocksCustodyAdapter` both refuse
      it (security review finding A1 — see `provider-config.integration-spec.ts`'s
      "Phase 14B.1 section 7" tests for the automated version of this).

## POST-TEST

- [ ] **Verify no duplicate submission** — exactly one `custodyReference`
      exists for the test withdrawal; `ProviderWebhookEvent` (if
      webhooks were used) has exactly one row per genuine delivery.
- [ ] **Verify reconciliation** — re-run the independent rescan; still
      zero discrepancies for this withdrawal.
- [ ] **Verify audit trail** — `GET /admin/audit-logs?resourceType=Withdrawal`
      shows the full real sequence (`withdrawal.request` →
      `withdrawal.approve` → `withdrawal.broadcast`/`withdrawal.provider_broadcast_recorded`
      → ...), each entry attributable to a real actor or `SYSTEM`.
- [ ] **Verify no secrets in logs** — grep your application logs for the
      literal API key/private key/webhook key content; none should
      appear (only references like `"env:FIREBLOCKS_SANDBOX_CREDENTIALS"`
      are ever logged).
- [ ] **Verify production remains fail-closed** — run
      `node scripts/production-readiness-check.js` against this same
      database; it must still report the custody P0 failure (production
      custody is not, and must not become, enabled by anything done in
      this checklist).
- [ ] **Record the result** — update `provider-capability-matrix.ts`'s
      `liveVerified` field to `true` for the exact row you successfully
      tested, in its own reviewed code change, with the real provider
      reference/date noted in the commit — never flip this flag without
      a genuine successful operation behind it.

## Known capability gaps (do not attempt to test these — they will fail by design)

- **XRP** — `UNSUPPORTED`. Any withdrawal with a destination tag is
  hard-refused by `FireblocksCustodyAdapter.execute()` before any
  network call, because the tag-bearing request shape was never
  verified. Do not attempt to work around this.
- **USDT** — the seeded `USDT`/`ethereum-sepolia` `AssetNetwork` row is
  `isActive: false` with no `contractAddress`, and the database itself
  refuses to activate it without one (`asset_networks_active_token_requires_contract_check`).
  **Do not add a contract address unless you have independently
  verified the real Sepolia USDT contract address yourself** — none is
  invented here.
- **SOL, and the EVM/Bitcoin rows generally** — `UNVERIFIED`, not
  `UNSUPPORTED`: the adapter WILL attempt these, but the literal
  `source.type`/`destination.type` enum strings and the `/transactions`
  path are inferred, not independently confirmed. This is exactly what
  this smoke test exists to resolve.
