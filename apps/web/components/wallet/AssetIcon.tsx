import { assetAccent } from "../../lib/wallet/asset-meta";

export function AssetIcon({ symbol, size = 32 }: { symbol: string; size?: number }) {
  const color = assetAccent(symbol);
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-display font-semibold text-black"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.36,
        backgroundColor: color,
      }}
    >
      {symbol.slice(0, 1)}
    </span>
  );
}
