"use client";

import type { MarketListFilterStatus } from "@verdictvaut/shared-types";
import { useMemo, useState } from "react";
import { Skeleton } from "../ui/Skeleton";
import { useMarkets } from "../../lib/trading/hooks";
import { MarketCard } from "./MarketCard";
import { MarketFilterTabs } from "./MarketFilterTabs";

export function MarketList() {
  const { data: markets, isLoading, isError, refetch } = useMarkets();
  const [filter, setFilter] = useState<MarketListFilterStatus | "ALL">("ALL");

  // The unfiltered fetch already returns exactly OPEN/CLOSED/RESOLVING/
  // RESOLVED (see MarketsService.list) — filtering here is purely a
  // client-side view over that one cached response, not a re-fetch per tab.
  const filtered = useMemo(() => (markets ?? []).filter((market) => filter === "ALL" || market.status === filter), [markets, filter]);

  return (
    <div className="space-y-5">
      <MarketFilterTabs value={filter} onChange={setFilter} />

      {isLoading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      )}

      {isError && !isLoading && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-vault-border bg-vault-surface p-6 text-sm text-white/60">
          <p>Couldn&apos;t load markets.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </div>
      )}

      {markets && !isLoading && filtered.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-vault-border bg-vault-surface py-16 text-center">
          <p className="text-sm font-medium text-white">No markets found</p>
          <p className="max-w-xs text-xs text-white/40">
            {markets.length === 0 ? "There are no markets available right now." : "No markets match this filter."}
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((market) => (
            <MarketCard key={market.id} market={market} />
          ))}
        </div>
      )}
    </div>
  );
}
