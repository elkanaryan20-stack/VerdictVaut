"use client";

import { useState } from "react";
import { useAuth } from "../../lib/auth/auth-context";
import { formatDateTime } from "../../lib/format";
import { useMarket, useMyPositions, useOrderBook } from "../../lib/trading/hooks";
import { isMarketTradable } from "../../lib/trading/order-status";
import { Skeleton } from "../ui/Skeleton";
import { OrderBook } from "../trading/OrderBook";
import { OrderTicket } from "../trading/OrderTicket";
import { MarketMyActivity } from "./MarketMyActivity";
import { MarketResolutionPanel } from "./MarketResolutionPanel";
import { MarketStatusBadge } from "./MarketStatusBadge";
import { OutcomeSelector } from "./OutcomeSelector";

export function MarketDetail({ slug }: { slug: string }) {
  const { status: authStatus } = useAuth();
  const { data: market, isLoading, isError, refetch } = useMarket(slug);
  const [selectedOutcomeId, setSelectedOutcomeId] = useState<string | null>(null);

  // Hooks must run unconditionally on every render (including the
  // loading/error renders below, before `market` exists yet) — this
  // derives outcome/order-book state defensively rather than after an
  // early return.
  const outcomes = market ? [...market.outcomes].sort((a, b) => a.sortOrder - b.sortOrder) : [];
  const activeOutcome = outcomes.find((o) => o.id === selectedOutcomeId) ?? outcomes[0] ?? null;
  const orderBookQuery = useOrderBook(market?.id ?? null, activeOutcome?.id ?? null, market?.status);
  const positionsQuery = useMyPositions(authStatus === "authenticated");
  const activePosition = activeOutcome ? (positionsQuery.data ?? []).find((p) => p.outcomeId === activeOutcome.id) ?? null : null;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 w-full lg:col-span-2" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (isError || !market) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-vault-border bg-vault-surface p-6 text-sm text-white/60">
        <p>Couldn&apos;t load this market.</p>
        <button
          type="button"
          onClick={() => refetch()}
          className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-white/40">{market.category.name}</span>
          <MarketStatusBadge status={market.status} />
        </div>
        <h1 className="font-display text-xl font-semibold text-white sm:text-2xl">{market.title}</h1>
        <p className="text-sm text-white/60">{market.description}</p>
        {market.resolutionCriteria && (
          <p className="text-xs text-white/40">
            <span className="font-medium text-white/60">Resolution criteria:</span> {market.resolutionCriteria}
          </p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/40">
          {market.closeTime && <span>Closes {formatDateTime(market.closeTime)}</span>}
          {market.resolutionTime && <span>Resolution target {formatDateTime(market.resolutionTime)}</span>}
        </div>
        {!isMarketTradable(market.status) && (
          <p className="rounded-lg border border-vault-border bg-white/[0.02] px-3 py-2 text-xs text-white/50">
            Trading is not available — this market is {market.status.toLowerCase()}.
          </p>
        )}
      </div>

      {outcomes.length > 0 && activeOutcome && (
        <OutcomeSelector outcomes={outcomes} selectedOutcomeId={activeOutcome.id} onSelect={setSelectedOutcomeId} />
      )}

      {(market.status === "RESOLVING" || market.status === "RESOLVED") && <MarketResolutionPanel market={market} />}

      {outcomes.length === 0 ? (
        <p className="text-sm text-white/50">This market has no outcomes configured.</p>
      ) : activeOutcome ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <OrderBook
              book={orderBookQuery.data}
              isLoading={orderBookQuery.isLoading}
              isError={orderBookQuery.isError}
              onRetry={() => orderBookQuery.refetch()}
            />
            <MarketMyActivity marketId={market.id} outcomes={outcomes} />
          </div>
          <div>
            <OrderTicket key={activeOutcome.id} market={market} outcome={activeOutcome} position={activePosition} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
