/**
 * Presentation-only accents — never used for any financial decision, and
 * never a source of truth for which assets are actually supported (that
 * always comes from the backend's own Asset/AssetNetwork data).
 */
export const ASSET_ACCENT: Record<string, string> = {
  BTC: "#f2a900",
  ETH: "#8fa3ff",
  SOL: "#14f195",
  USDC: "#2775ca",
  USDT: "#26a17b",
  XRP: "#3aa7e0",
};

export function assetAccent(symbol: string): string {
  return ASSET_ACCENT[symbol] ?? "#c9a24b";
}

export const NETWORK_FAMILY_LABEL: Record<string, string> = {
  BITCOIN: "Bitcoin",
  EVM: "EVM",
  SOLANA: "Solana",
  XRPL: "XRP Ledger",
};
