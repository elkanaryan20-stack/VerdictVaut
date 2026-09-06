"use client";

import type { AssetNetworkView } from "@verdictvaut/shared-types";
import { cn } from "../../lib/cn";
import { NETWORK_FAMILY_LABEL } from "../../lib/wallet/asset-meta";

export function NetworkSelector({
  options,
  selectedNetworkCode,
  onSelect,
}: {
  options: AssetNetworkView[];
  selectedNetworkCode: string | null;
  onSelect: (networkCode: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Select a network" className="flex flex-col gap-2">
      {options.map((option) => {
        const isSelected = option.network.code === selectedNetworkCode;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onSelect(option.network.code)}
            className={cn(
              "flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold",
              isSelected ? "border-vault-gold bg-vault-gold/10" : "border-vault-border bg-white/[0.02] hover:bg-white/5",
            )}
          >
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-medium", isSelected ? "text-vault-gold" : "text-white")}>{option.network.name}</p>
              <p className="text-xs text-white/40">
                {NETWORK_FAMILY_LABEL[option.network.family] ?? option.network.family}
                {option.memoRequired && " · Destination tag required"}
                {!option.isNative && " · Token"}
              </p>
            </div>
            <p className="shrink-0 whitespace-nowrap pl-3 text-xs text-white/40">{option.minConfirmations} confirmations</p>
          </button>
        );
      })}
    </div>
  );
}
