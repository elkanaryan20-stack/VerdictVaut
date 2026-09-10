import { NetworkFamily } from "@prisma/client";

/**
 * A static, honestly-labeled record of what Phase 14B's provider
 * adapters actually support, capability by capability, network family
 * by network family — NOT a claim about what a provider theoretically
 * supports in general, only what THIS codebase has verified and wired
 * up. Read via AdminController's SUPER_ADMIN-only capability-matrix
 * endpoint (never editable at runtime — a code change, with its own
 * review, is required to move an entry between statuses).
 *
 *   VERIFIED       — every fact this capability's request/response
 *                     handling relies on has been independently
 *                     confirmed against the provider's own primary/
 *                     authoritative documentation (a literal worked
 *                     example, not an inferred convention). This is
 *                     documentation-level verification only — see
 *                     `liveVerified` below for whether it has ALSO been
 *                     exercised against a real provider sandbox account.
 *   UNVERIFIED     — the provider likely supports this, but at least
 *                     one fact this capability's request/response
 *                     handling relies on was NOT independently confirmed
 *                     against authoritative documentation this
 *                     codebase's research passes could access — an
 *                     inferred convention, a "high-confidence but not
 *                     literally re-rendered" detail, or a gap the
 *                     research pass simply couldn't close. NEVER wired
 *                     up to actually execute without an explicit,
 *                     admin-verified escape hatch (e.g.
 *                     WithdrawalExecutionConfig.providerAssetId) — see
 *                     each adapter's own fail-closed handling.
 *   UNSUPPORTED    — no adapter code path exists for this combination at
 *                     all (distinct from UNVERIFIED: this isn't "we
 *                     didn't check," it's "we know of no verified way to
 *                     do this and have not attempted to guess one").
 *
 * `liveVerified: false` on EVERY row below is not a placeholder — it is
 * the honest current state as of Phase 14B.1: no entry in this matrix
 * has ever been exercised against a real provider sandbox account (see
 * docs/fireblocks-sandbox-smoke-test.md and the "LIVE VERIFICATION"
 * section of docs/provider-integration.md). A passing unit/integration
 * test suite proves this codebase's OWN request-construction and
 * response-interpretation logic against a mocked HTTP layer — it does
 * NOT prove the real provider actually accepts the request or behaves
 * as documented. Do not flip `liveVerified` to true for any row without
 * a real, successful sandbox operation producing a genuine provider
 * reference, recorded in the smoke-test log.
 */
export type ProviderCapabilityStatus = "VERIFIED" | "UNVERIFIED" | "UNSUPPORTED";

export interface ProviderCapabilityEntry {
  provider: "fireblocks" | "elliptic" | "chainalysis";
  capability: "custody_execution" | "address_risk_screening";
  networkFamily: NetworkFamily;
  /** Representative assets on this network family, for readability only — status applies to the whole network family's request shape, not per-asset. */
  exampleAssets: string[];
  status: ProviderCapabilityStatus;
  /** Has this row been exercised against a REAL provider sandbox account with a genuine result? See this file's own docblock. */
  liveVerified: boolean;
  note: string;
}

export const PROVIDER_CAPABILITY_MATRIX: readonly ProviderCapabilityEntry[] = [
  {
    provider: "fireblocks",
    capability: "custody_execution",
    networkFamily: NetworkFamily.EVM,
    exampleAssets: ["ETH", "USDC", "USDT"],
    status: "UNVERIFIED",
    liveVerified: false,
    note:
      "Auth scheme, request field NAMES (assetId, amount, source, destination, externalTxId), the externalTxId idempotency mechanism, and the full transaction " +
      "status enum ARE VERIFIED against developers.fireblocks.com. However, the literal enum strings source.type=\"VAULT_ACCOUNT\"/destination.type=\"ONE_TIME_ADDRESS\" " +
      "and the exact path \"/transactions\" are Fireblocks' well-known account-model terminology, inferred from the reference page's own operation id — NOT " +
      "independently re-confirmed as literal values against a worked example in this research pass (see FireblocksCustodyAdapter's own docblock). Because the " +
      "adapter's request as a WHOLE has not been confirmed against authoritative documentation end-to-end, this row is classified UNVERIFIED, not VERIFIED, " +
      "even though most of it is solidly sourced. Per-asset assetId strings are separately NEVER hardcoded — an admin must set " +
      "WithdrawalExecutionConfig.providerAssetId after independently verifying it in their own Fireblocks console; FireblocksCustodyAdapter refuses to execute " +
      "without one. MUST be smoke-tested against a real Fireblocks sandbox account (docs/fireblocks-sandbox-smoke-test.md) before liveVerified may become true.",
  },
  {
    provider: "fireblocks",
    capability: "custody_execution",
    networkFamily: NetworkFamily.BITCOIN,
    exampleAssets: ["BTC"],
    status: "UNVERIFIED",
    liveVerified: false,
    note: "Same request shape and same verification gaps as the EVM row above (Fireblocks' transaction-creation API is asset-agnostic) — providerAssetId still required and never guessed.",
  },
  {
    provider: "fireblocks",
    capability: "custody_execution",
    networkFamily: NetworkFamily.SOLANA,
    exampleAssets: ["SOL"],
    status: "UNVERIFIED",
    liveVerified: false,
    note: "Same request shape and same verification gaps as the EVM row above — providerAssetId still required and never guessed.",
  },
  {
    provider: "fireblocks",
    capability: "custody_execution",
    networkFamily: NetworkFamily.XRPL,
    exampleAssets: ["XRP"],
    status: "UNSUPPORTED",
    liveVerified: false,
    note:
      "XRP withdrawals require a destination tag. The exact request shape for a tag-bearing destination on Fireblocks' transaction-creation endpoint was NOT verified " +
      "in the Phase 14B research pass (the documented 'address:tag' convention was for vault/whitelist addresses, not confirmed for this endpoint) — " +
      "FireblocksCustodyAdapter.execute() explicitly refuses any request carrying a destinationTag rather than guessing.",
  },
  {
    provider: "elliptic",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.EVM,
    exampleAssets: ["ETH", "USDC", "USDT"],
    status: "VERIFIED",
    liveVerified: false,
    note:
      "The full {asset: \"holistic\", blockchain: \"holistic\", type: \"address\"} wallet_exposure request AND response shape were confirmed against a literal, " +
      "complete worked example on developers.elliptic.co (a documented Ethereum address) — screens the address's exposure regardless of which EVM asset is being " +
      "withdrawn. This is DOCUMENTATION-level verification only — no real Elliptic account has ever been called; liveVerified remains false until one is.",
  },
  {
    provider: "elliptic",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.BITCOIN,
    exampleAssets: ["BTC"],
    status: "UNSUPPORTED",
    liveVerified: false,
    note:
      'Only a {asset: "BTC", type: "transaction", ...} example was found (screening a TRANSACTION, not an address) — a materially different request. ' +
      "No verified address-type subject shape for Bitcoin was found in the Phase 14B research pass; not guessed.",
  },
  {
    provider: "elliptic",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.SOLANA,
    exampleAssets: ["SOL"],
    status: "UNSUPPORTED",
    liveVerified: false,
    note: "No Solana request example or asset/blockchain identifier was found in the Phase 14B research pass; not guessed.",
  },
  {
    provider: "elliptic",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.XRPL,
    exampleAssets: ["XRP"],
    status: "UNSUPPORTED",
    liveVerified: false,
    note: "No XRP request example or asset/blockchain identifier was found in the Phase 14B research pass; not guessed.",
  },
  {
    provider: "chainalysis",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.EVM,
    exampleAssets: ["ETH", "USDC", "USDT"],
    status: "UNSUPPORTED",
    liveVerified: false,
    note:
      "Chainalysis was considered as a candidate compliance provider (Phase 14B section 6) but its primary API documentation was not reliably accessible " +
      "during this research pass (DNS failures / login walls / 404s). No adapter exists — this is NOT a claim that Chainalysis lacks the capability, only " +
      "that this codebase has not verified or implemented it.",
  },
  {
    provider: "chainalysis",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.BITCOIN,
    exampleAssets: ["BTC"],
    status: "UNSUPPORTED",
    liveVerified: false,
    note: "See the EVM row above — Chainalysis is entirely unimplemented, for every network family.",
  },
  {
    provider: "chainalysis",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.SOLANA,
    exampleAssets: ["SOL"],
    status: "UNSUPPORTED",
    liveVerified: false,
    note: "See the EVM row above — Chainalysis is entirely unimplemented, for every network family.",
  },
  {
    provider: "chainalysis",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.XRPL,
    exampleAssets: ["XRP"],
    status: "UNSUPPORTED",
    liveVerified: false,
    note: "See the EVM row above — Chainalysis is entirely unimplemented, for every network family.",
  },
] as const;
