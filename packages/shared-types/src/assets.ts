/**
 * Canonical list of assets supported at the MVP/testing stage.
 * Adding an asset later is a data change (see AssetNetwork), not a code change here —
 * this list only exists to give the frontend/API a shared, type-safe symbol union.
 */
export const SUPPORTED_ASSET_SYMBOLS = [
  "BTC",
  "ETH",
  "SOL",
  "USDC",
  "USDT",
  "XRP",
] as const;

export type AssetSymbol = (typeof SUPPORTED_ASSET_SYMBOLS)[number];

export const SETTLEMENT_ASSET_SYMBOL: AssetSymbol = "USDC";

export const NETWORK_FAMILIES = ["BITCOIN", "EVM", "SOLANA", "XRPL"] as const;
export type NetworkFamily = (typeof NETWORK_FAMILIES)[number];

export const NETWORK_ENVIRONMENTS = ["SANDBOX", "PRODUCTION"] as const;
export type NetworkEnvironment = (typeof NETWORK_ENVIRONMENTS)[number];
