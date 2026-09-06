"use client";

import { cn } from "../../lib/cn";
import { AssetIcon } from "./AssetIcon";

export interface AssetOption {
  symbol: string;
  name: string;
}

export function AssetSelector({
  assets,
  selected,
  onSelect,
}: {
  assets: AssetOption[];
  selected: string | null;
  onSelect: (symbol: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Select an asset to deposit" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {assets.map((asset) => {
        const isSelected = asset.symbol === selected;
        return (
          <button
            key={asset.symbol}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onSelect(asset.symbol)}
            className={cn(
              "flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold",
              isSelected ? "border-vault-gold bg-vault-gold/10" : "border-vault-border bg-white/[0.02] hover:bg-white/5",
            )}
          >
            <AssetIcon symbol={asset.symbol} size={28} />
            <div className="min-w-0">
              <p className={cn("text-sm font-medium", isSelected ? "text-vault-gold" : "text-white")}>{asset.symbol}</p>
              <p className="truncate text-xs text-white/40">{asset.name}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}
