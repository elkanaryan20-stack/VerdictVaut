# Provider Integration — Phase 14B

This document is the honest current state of VerdictVaut's external
custody/compliance provider integrations. It labels every capability
**VERIFIED** (confirmed against the provider's own primary
documentation, or genuinely tested end-to-end), **UNVERIFIED** (likely
true but not confirmed this pass — never wired up to actually execute),
or **UNSUPPORTED**/**NOT YET IMPLEMENTED** (no code path exists). It
makes no legal, regulatory, or compliance claim — "a compliance
provider adapter exists" is a statement about software, not about
regulatory sign-off.

**Everything in this document describes SANDBOX-only behavior unless
explicitly stated otherwise. Production custody execution and
production automated compliance screening remain fully disabled — see
§9.**

## 1. Provider-neutral architecture (unchanged from Phase 14A)

Nothing about the core architecture changed in Phase 14B — it was
built, in Phase 14A, specifically to make a real integration like this
one a matter of adding an adapter, not restructuring the platform:

- `WithdrawalExecutor` (interface) — one method (`execute`), one
  optional method (`checkStatus`), selected per asset/network by
  `WithdrawalExecutorFactory` from `WithdrawalExecutionConfig` +
  `CustodyProviderConfig` DB rows.
- `WithdrawalComplianceGate` (interface) — one method (`assess`),
  bound once via NestJS DI to `ComplianceGateFactory`, which itself
  routes to a real adapter or the honest `DeferredComplianceGate`
  fallback based on environment + `ComplianceProviderConfig` DB rows.
- Both factories are **fail-closed by construction**: an unrecognized
  or disabled provider configuration throws rather than silently
  falling back to a weaker default.

## 2. What Phase 14B actually adds

| Component | What it is |
|---|---|
| `FireblocksCustodyAdapter` | A real `WithdrawalExecutor` implementation calling the real Fireblocks REST API (sandbox base URL). |
| Fireblocks webhook stack (`FireblocksWebhookController`/`Service`) | A real, signature-verified webhook receiver at `POST /webhooks/fireblocks`, converging with the polling path on the same `WithdrawalsService` state-transition methods. |
| `EllipticAddressRiskGate` | A real `WithdrawalComplianceGate` implementation calling the real Elliptic AML API (EVM addresses only). |
| `SecretResolverService` | Resolves a `"scheme:path"` secret reference to a real value — only the `env:` scheme is implemented; every other scheme fails closed. |
| `PROVIDER_CAPABILITY_MATRIX` | A static, code-reviewed table of exactly what's VERIFIED/UNVERIFIED/UNSUPPORTED per provider × network family — see §5, readable via `GET /admin/providers/capability-matrix` (SUPER_ADMIN only). |
| `IndependentReconciliationService` extension | Detects a withdrawal known internally but rejected/missing at the provider — see §8. |

## 3. Custody: Fireblocks (sandbox only)

**Why Fireblocks over BitGo:** the Phase 14 research pass found
Fireblocks' REST API documentation more directly accessible and
verifiable than BitGo's within this research session. This is **not**
a claim that Fireblocks is the better provider for VerdictVaut's actual
production needs — that remains a real business decision.

### VERIFIED (confirmed against developers.fireblocks.com)

- **Auth**: `X-API-Key` header + `Authorization: Bearer <RS256 JWT>`.
  JWT claims: `{uri, nonce, iat, exp (iat+30s), sub: apiKey, bodyHash:
  sha256hex(body)}`.
- **Idempotency**: the request-body field `externalTxId` — "additional
  transaction requests with the same externalTxId value are not
  processed." VerdictVaut always sends its own withdrawal id as this
  field.
- **Request field NAMES**: `assetId`, `amount`, `source`, `destination`,
  `externalTxId`, `note`.
- **Full transaction status enum**: SUBMITTED, PENDING_AML_SCREENING,
  PENDING_ENRICHMENT, PENDING_AUTHORIZATION, QUEUED, PENDING_SIGNATURE,
  SIGNED, PENDING_3RD_PARTY_MANUAL_APPROVAL, PENDING_3RD_PARTY,
  BROADCASTING, CONFIRMING, COMPLETED, CANCELLING, CANCELLED, BLOCKED,
  REJECTED, FAILED. Any other string is treated as
  **UnrecognizedFireblocksStatusError** (ambiguous), never guessed.
- **Webhooks**: the legacy `Fireblocks-Signature` header —
  `base64(RSA-SHA512(raw request body))`, verified against a public key
  an admin configures as a `CustodyProviderConfig.webhookSecretRef`.

### HIGH-CONFIDENCE BUT NOT INDEPENDENTLY RE-CONFIRMED THIS PASS

- The exact path `/transactions` (inferred from the reference page's
  own operation id, not seen as a literal example).
- The literal strings `source.type: "VAULT_ACCOUNT"` /
  `destination.type: "ONE_TIME_ADDRESS"` — Fireblocks' well-known
  account-model terminology.

**Both of these MUST be smoke-tested against a real Fireblocks sandbox
account before this adapter is trusted operationally — see §10.**

### EXPLICITLY UNVERIFIED — fails closed, never guessed

- **Per-asset `assetId` strings.** `WithdrawalExecutionConfig.providerAssetId`
  is nullable and admin-set only; `FireblocksCustodyAdapter.supportsAssetNetwork()`
  returns `false` (routing fails closed to "unsupported") until an
  admin sets it, having independently verified the correct string in
  their own Fireblocks console.
- **The destination-tag/memo request shape** (needed for XRP).
  `execute()` explicitly throws if `request.destinationTag` is set,
  rather than guessing a shape for the docmented address-with-tag
  convention (which was confirmed for whitelisted addresses, not for
  transaction creation).
- **The newer JWKS-based `Fireblocks-Webhook-Signature` header** — only
  the legacy `Fireblocks-Signature` scheme is implemented.

## 4. Compliance: Elliptic (sandbox, address-risk screening only)

**Why Elliptic over Chainalysis:** Chainalysis's primary API
documentation was not reliably reachable during this research pass
(DNS failures, login walls, 404s on all attempted endpoints).
**Chainalysis is NOT implemented — this is not a statement that
Chainalysis lacks the capability, only that it was not verified.**

### VERIFIED (confirmed against developers.elliptic.co)

- **Auth**: HMAC-SHA256 over
  `` `${timestampMs}${METHOD_UPPER}${path.toLowerCase()}${payload}` ``
  (payload = JSON body, or `"{}"` for none), keyed by the
  base64-decoded API secret, sent as
  `x-access-key`/`x-access-sign`/`x-access-timestamp` headers.
- **Base URL**: `https://aml-api.elliptic.co/v2`.
- **`POST /wallet`**: submits a batch (1–100) of
  `{subject: {asset, blockchain, type, hash}, type: "wallet_exposure"}`
  requests, returns an array of `{id, process_status, ...}`.
- **`GET /wallet/{id}`**: returns `{risk_score: number|null,
  process_status: "running"|"complete"|"error", ...}`. **`risk_score`
  has no documented categorical enum** — VerdictVaut maps it to
  `AddressRiskStatus` (LOW/MEDIUM/HIGH) via two admin-configured
  thresholds (`ComplianceProviderConfig.riskScoreMediumThreshold`/
  `riskScoreHighThreshold`) — this mapping is VerdictVaut policy, not
  an Elliptic-defined categorization.
- **The `{asset: "holistic", blockchain: "holistic", type: "address"}`
  subject shape** is confirmed via a documented Ethereum-address
  example — this screens any EVM address regardless of which specific
  asset (ETH, USDC, USDT-on-Ethereum) is being withdrawn.

### EXPLICITLY UNVERIFIED/UNSUPPORTED — fails closed, never guessed

- **Bitcoin, Solana, XRP address-type screening.** Only a
  `{asset: "BTC", type: "transaction", ...}` example was found for
  Bitcoin (a *transaction* subject, materially different from an
  *address* subject) — no address-shape example was found for any
  non-EVM chain. `EllipticAddressRiskGate.supportsNetworkFamily()`
  returns `true` only for `NetworkFamily.EVM`; every other network
  family is honestly reported as `NOT_PERFORMED`, never guessed.
- **Idempotency on `POST /wallet`.** No idempotency-key mechanism is
  documented — this gate submits at most once per `assess()` call and
  never auto-retries a submission.
- **Bounded async completion.** `wallet_exposure` analyses are
  documented as asynchronous. This gate does **not** poll/sleep — it
  makes exactly one immediate follow-up `GET` after submission and
  honestly reports `NOT_PERFORMED` (never a fabricated score) if the
  analysis has not completed by then. See §11 known limitations.

### KYC and sanctions-list screening

Elliptic's documented API is an AML/wallet-exposure product — it is
**not** a KYC identity-verification or sanctions-list product. Every
withdrawal's `kycStatus` and `sanctionsScreeningStatus` therefore
remain `NOT_PERFORMED` even when Elliptic address-risk screening runs.

## 5. Asset/network capability matrix

The canonical, code-reviewed source of truth is
`src/wallet/provider-config/provider-capability-matrix.ts` (readable
via `GET /admin/providers/capability-matrix`, SUPER_ADMIN only).
Summary:

| Network family | Fireblocks custody execution | Elliptic address-risk screening | Chainalysis |
|---|---|---|---|
| EVM (ETH, USDC, USDT-on-Ethereum) | VERIFIED* | VERIFIED | UNSUPPORTED |
| Bitcoin (BTC) | VERIFIED* | UNSUPPORTED | UNSUPPORTED |
| Solana (SOL) | VERIFIED* | UNSUPPORTED | UNSUPPORTED |
| XRPL (XRP) | UNSUPPORTED (destination-tag shape unverified) | UNSUPPORTED | UNSUPPORTED |

\* "VERIFIED" here means the request shape and status-interpretation
are verified — the per-asset `providerAssetId` is still a required,
admin-verified, never-inferred configuration value (§3).

## 6. Withdrawal lifecycle with a real provider

```
REQUESTED -> RISK_REVIEW -> APPROVED -> BROADCASTING (execution lease)
  -> executor.execute() called exactly once per lease acquisition:
     - "broadcast"                -> BROADCAST (txHash known immediately)
     - "awaiting_manual_broadcast" -> PENDING_MANUAL_BROADCAST (Fireblocks
                                       accepted the submission; txHash not
                                       yet known — resolved later by EITHER
                                       the watcher's poll OR a webhook)
     - "ambiguous"                -> EXECUTION_AMBIGUOUS (SUPER_ADMIN must
                                       resolve manually — see §7)
  PENDING_MANUAL_BROADCAST -> BROADCAST, via WithdrawalsService.recordProviderBroadcast(),
    called identically by WithdrawalWatcherService's poll (checkStatus())
    and FireblocksWebhookService (webhook) — both converge on the SAME
    CAS-guarded transition, so a webhook and a poll can never disagree
    or double-apply.
  -> CONFIRMING -> CONFIRMED -> CREDITED (unchanged from Phase 9/10)
```

`providerReference` (the provider's own transaction id, e.g. a
Fireblocks transaction id) is stored separately from `txHash` (the real
on-chain hash) in `Withdrawal.custodyReference` — the two are never
conflated, since a provider id exists before a transaction is ever
broadcast on-chain.

## 7. Ambiguous execution handling (unchanged, real for Fireblocks)

A 5xx response, a transport error/timeout, or a malformed response from
Fireblocks during `execute()` is treated as **ambiguous** — never
assumed to be a safe-to-retry failure, since the withdrawal may have
actually been submitted before the failure occurred. The reservation
stays held; only a SUPER_ADMIN's explicit
`resolveAmbiguousExecution()` call (Phase 9) resolves it, backed by
manually checking the real Fireblocks console/API. This behavior is
unchanged by Phase 14B — `FireblocksCustodyAdapter.execute()` simply
plugs a real provider into an already-existing safety mechanism.

## 8. Webhook security and reconciliation

- **Signature verification is unconditional and runs before JSON
  parsing** — `FireblocksWebhookController` rejects any request missing
  or failing `Fireblocks-Signature` verification with 401, checked
  against every enabled `CustodyProviderConfig` with a Fireblocks
  provider name and a configured `webhookSecretRef` (the verification
  key itself is stored as a secret reference, even though it's
  technically public, reusing the existing secret-reference mechanism
  rather than inventing a new config field).
- **Replay/duplicate protection**: `externalEventId` is derived
  deterministically as `` `${txId}:${status}:${lastUpdated}` `` (Fireblocks
  documents no distinct webhook delivery id) and enforced by a real DB
  unique constraint on `(provider, externalEventId)` — verified under
  concurrent delivery in `fireblocks-webhook.integration-spec.ts`.
- **No direct balance mutation**: the webhook handler's only direct
  write is a `ProviderWebhookEvent` audit row; every actual state
  transition goes through `WithdrawalsService`, identically to the
  polling path.
- **Reconciliation**: `IndependentReconciliationService.checkPendingProviderSubmissions()`
  independently re-checks every `PENDING_MANUAL_BROADCAST` withdrawal
  with a recorded `custodyReference` against the provider's own
  `checkStatus()`, producing a `CRITICAL` `ReconciliationDiscrepancy`
  (never an automatic mutation) if the provider reports the submission
  missing or rejected without VerdictVaut having recorded that outcome.
  A SUPER_ADMIN can also list/reprocess raw webhook events directly via
  `GET`/`POST /admin/providers/webhook-events*`.

## 9. Production safety (unchanged posture, now with a real sandbox contrast)

Production remains fully fail-closed:

- `WithdrawalExecutorFactory.resolve()` **always** returns the
  unconditionally-throwing `ProductionCustodyExecutor` in production,
  regardless of any `CustodyProviderConfig`/`WithdrawalExecutionConfig`
  state — the Fireblocks adapter is only ever selected in sandbox.
- `ComplianceGateFactory.assess()` **always** delegates to
  `DeferredComplianceGate` in production, regardless of any
  `ComplianceProviderConfig` state — `EllipticAddressRiskGate` is only
  ever selected in sandbox.
- `scripts/production-readiness-check.js` verifies both of the above
  directly from source and fails P0 until a real provider is
  deliberately wired into production — see that script's own output.

## 10. Staging/sandbox setup

No real credentials exist anywhere in this repository. To exercise
these adapters against a real Fireblocks/Elliptic sandbox account:

```
# Fireblocks (JSON: {"apiKey": "...", "privateKey": "-----BEGIN PRIVATE KEY-----..."})
FIREBLOCKS_SANDBOX_CREDENTIALS='{"apiKey":"...","privateKey":"..."}'
# Elliptic (JSON: {"apiKey": "...", "apiSecret": "<base64>"})
ELLIPTIC_SANDBOX_CREDENTIALS='{"apiKey":"...","apiSecret":"..."}'
# The Fireblocks webhook verification public key (PEM, technically public but stored via the same secret-reference mechanism)
FIREBLOCKS_WEBHOOK_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----...'
```

Then, as SUPER_ADMIN:

1. `POST /admin/custody/providers` — `{providerName: "Fireblocks", environment: "SANDBOX", apiBaseUrl: "https://sandbox-api.fireblocks.io/v1", credentialsSecretRef: "env:FIREBLOCKS_SANDBOX_CREDENTIALS", webhookSecretRef: "env:FIREBLOCKS_WEBHOOK_PUBLIC_KEY", vaultOrAccountRef: "<your vault account id>"}`.
2. `POST /admin/custody/providers/:id/enable`.
3. `POST /admin/custody/execution-config` — `{assetNetworkId: "<eth-sepolia asset/network id>", environment: "SANDBOX", executorType: "PRODUCTION_CUSTODY", custodyProviderConfigId: "<id from step 1>", providerAssetId: "<verified in the Fireblocks console — never guess this>"}`.
4. `POST /admin/compliance/providers` — `{category: "SANCTIONS_KYT", providerName: "Elliptic", environment: "SANDBOX", apiBaseUrl: "https://aml-api.elliptic.co/v2", credentialsSecretRef: "env:ELLIPTIC_SANDBOX_CREDENTIALS", riskScoreMediumThreshold: 0.3, riskScoreHighThreshold: 0.7}` — pick real thresholds deliberately, not these placeholder values.
5. `POST /admin/compliance/providers/:id/enable`.

## 11. Known limitations

- Elliptic address-risk screening does not poll for a still-`running`
  analysis — it reports `NOT_PERFORMED` and defers to human review
  rather than blocking the withdrawal request on an unbounded wait. A
  future phase should resolve still-pending analyses asynchronously,
  mirroring `WithdrawalWatcherService`'s existing provider-polling
  pattern for custody.
- Fireblocks' newer JWKS-based webhook signature scheme is not
  implemented — only the legacy RSA-SHA512 scheme.
- The Fireblocks `source.type`/`destination.type` literal enum values
  and the `/transactions` path itself are high-confidence but not
  independently re-confirmed this pass — see §3. **Do not treat this
  adapter as production-trustworthy without a real sandbox smoke
  test.**
- No "provider withdrawal known but absent internally" reverse
  reconciliation check exists — this would require a verified
  "list transactions" capability, which was not confirmed this pass.
- Chainalysis remains entirely unimplemented (§4).
- None of this constitutes legal or regulatory compliance advice or
  certification — "a compliance provider adapter exists" describes
  software, not a completed compliance program.
