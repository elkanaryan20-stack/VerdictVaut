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
 *   VERIFIED       — confirmed against the provider's own primary
 *                     documentation (or, for a per-asset id like a
 *                     Fireblocks assetId, requires nothing beyond an
 *                     admin explicitly configuring a value they have
 *                     independently verified in their own provider
 *                     account — see WithdrawalExecutionConfig.providerAssetId).
 *   UNVERIFIED     — the provider likely supports this, but this
 *                     codebase found no primary-source confirmation of
 *                     the exact request/response shape in the Phase 14B
 *                     research pass. NEVER wired up to actually execute
 *                     — see each adapter's own fail-closed handling.
 *   UNSUPPORTED    — no adapter code path exists for this combination at
 *                     all (distinct from UNVERIFIED: this isn't "we
 *                     didn't check," it's "we know of no verified way to
 *                     do this and have not attempted to guess one").
 */
export type ProviderCapabilityStatus = "VERIFIED" | "UNVERIFIED" | "UNSUPPORTED";

export interface ProviderCapabilityEntry {
  provider: "fireblocks" | "elliptic" | "chainalysis";
  capability: "custody_execution" | "address_risk_screening";
  networkFamily: NetworkFamily;
  /** Representative assets on this network family, for readability only — status applies to the whole network family's request shape, not per-asset. */
  exampleAssets: string[];
  status: ProviderCapabilityStatus;
  note: string;
}

export const PROVIDER_CAPABILITY_MATRIX: readonly ProviderCapabilityEntry[] = [
  {
    provider: "fireblocks",
    capability: "custody_execution",
    networkFamily: NetworkFamily.EVM,
    exampleAssets: ["ETH", "USDC", "USDT"],
    status: "VERIFIED",
    note:
      "Auth scheme, request field NAMES (assetId, amount, source, destination, externalTxId), the externalTxId idempotency mechanism, and the full transaction " +
      "status enum are VERIFIED against developers.fireblocks.com. The literal enum strings source.type=\"VAULT_ACCOUNT\"/destination.type=\"ONE_TIME_ADDRESS\" are " +
      "Fireblocks' well-known account-model terminology but were NOT independently re-confirmed as literal values in this research pass — see " +
      "FireblocksCustodyAdapter's own docblock. Per-asset assetId strings are NOT hardcoded — an admin must set WithdrawalExecutionConfig.providerAssetId after " +
      "independently verifying it in their own Fireblocks console; FireblocksCustodyAdapter refuses to execute without one.",
  },
  {
    provider: "fireblocks",
    capability: "custody_execution",
    networkFamily: NetworkFamily.BITCOIN,
    exampleAssets: ["BTC"],
    status: "VERIFIED",
    note: "Same request shape and same verification caveats as the EVM row above (Fireblocks' transaction-creation API is asset-agnostic) — providerAssetId still required and never guessed.",
  },
  {
    provider: "fireblocks",
    capability: "custody_execution",
    networkFamily: NetworkFamily.SOLANA,
    exampleAssets: ["SOL"],
    status: "VERIFIED",
    note: "Same request shape and same verification caveats as the EVM row above — providerAssetId still required and never guessed.",
  },
  {
    provider: "fireblocks",
    capability: "custody_execution",
    networkFamily: NetworkFamily.XRPL,
    exampleAssets: ["XRP"],
    status: "UNSUPPORTED",
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
    note:
      'The {asset: "holistic", blockchain: "holistic", type: "address"} wallet_exposure request VERIFIED against developers.elliptic.co using a documented ' +
      "Ethereum address example — screens the address's exposure regardless of which EVM asset is being withdrawn.",
  },
  {
    provider: "elliptic",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.BITCOIN,
    exampleAssets: ["BTC"],
    status: "UNSUPPORTED",
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
    note: "No Solana request example or asset/blockchain identifier was found in the Phase 14B research pass; not guessed.",
  },
  {
    provider: "elliptic",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.XRPL,
    exampleAssets: ["XRP"],
    status: "UNSUPPORTED",
    note: "No XRP request example or asset/blockchain identifier was found in the Phase 14B research pass; not guessed.",
  },
  {
    provider: "chainalysis",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.EVM,
    exampleAssets: ["ETH", "USDC", "USDT"],
    status: "UNSUPPORTED",
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
    note: "See the EVM row above — Chainalysis is entirely unimplemented, for every network family.",
  },
  {
    provider: "chainalysis",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.SOLANA,
    exampleAssets: ["SOL"],
    status: "UNSUPPORTED",
    note: "See the EVM row above — Chainalysis is entirely unimplemented, for every network family.",
  },
  {
    provider: "chainalysis",
    capability: "address_risk_screening",
    networkFamily: NetworkFamily.XRPL,
    exampleAssets: ["XRP"],
    status: "UNSUPPORTED",
    note: "See the EVM row above — Chainalysis is entirely unimplemented, for every network family.",
  },
] as const;
