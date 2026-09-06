"use client";

import type { MarketListFilterStatus } from "@verdictvaut/shared-types";
import { cn } from "../../lib/cn";
import { MARKET_STATUS_LABEL } from "../../lib/trading/order-status";

const FILTERS: Array<{ value: MarketListFilterStatus | "ALL"; label: string }> = [
  { value: "ALL", label: "All" },
  { value: "OPEN", label: MARKET_STATUS_LABEL.OPEN },
  { value: "CLOSED", label: MARKET_STATUS_LABEL.CLOSED },
  { value: "RESOLVING", label: MARKET_STATUS_LABEL.RESOLVING },
  { value: "RESOLVED", label: MARKET_STATUS_LABEL.RESOLVED },
];

export function MarketFilterTabs({
  value,
  onChange,
}: {
  value: MarketListFilterStatus | "ALL";
  onChange: (value: MarketListFilterStatus | "ALL") => void;
}) {
  return (
    <div role="tablist" aria-label="Filter markets by status" className="flex flex-wrap gap-2">
      {FILTERS.map((filter) => {
        const active = filter.value === value;
        return (
          <button
            key={filter.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(filter.value)}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold",
              active ? "border-vault-gold bg-vault-gold/10 text-vault-gold" : "border-vault-border text-white/60 hover:bg-white/5 hover:text-white",
            )}
          >
            {filter.label}
          </button>
        );
      })}
    </div>
  );
}
