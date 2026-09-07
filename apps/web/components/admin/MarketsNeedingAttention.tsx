"use client";

import Link from "next/link";
import { useMarketsNeedingAttention } from "../../lib/admin/hooks";
import { formatDateTime } from "../../lib/format";
import { Badge } from "../ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";

/**
 * Every RESOLVING market — resolved, but settlement hasn't finished
 * paying out every position — built entirely from the same PUBLIC market
 * endpoints Phase 6B's MarketResolutionPanel already uses. See
 * useMarketsNeedingAttention's docblock for why no admin-only backend
 * call was needed for this.
 */
export function MarketsNeedingAttention() {
  const { items, isLoading, isError, hasPartialError, refetch } = useMarketsNeedingAttention();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Markets needing attention</CardTitle>
      </CardHeader>

      {isLoading && (
        <CardBody className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardBody>
      )}

      {isError && !isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load resolving markets.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <CardBody className="py-8 text-center text-sm text-white/50">No markets are currently mid-settlement.</CardBody>
      )}

      {!isLoading && !isError && items.length > 0 && (
        <>
          {hasPartialError && (
            <CardBody className="border-b border-vault-border bg-vault-down/5 py-2.5 text-xs text-white/60">
              <p role="alert">Some markets&apos; settlement progress couldn&apos;t be loaded — the list below may be incomplete.</p>
            </CardBody>
          )}
          <div className="divide-y divide-vault-border">
            {items.map(({ market, resolution }) => (
              <div key={market.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <Link href={`/markets/${market.slug}`} className="truncate text-sm font-medium text-white hover:text-vault-gold">
                    {market.title}
                  </Link>
                  {resolution?.resolution && (
                    <p className="mt-1 text-xs text-white/40">Resolved {formatDateTime(resolution.resolution.resolvedAt)}</p>
                  )}
                </div>
                {resolution ? (
                  <Badge tone={resolution.settlement.settledPositions === resolution.settlement.totalPositions ? "up" : "gold"}>
                    {resolution.settlement.settledPositions} of {resolution.settlement.totalPositions} settled
                  </Badge>
                ) : (
                  <Badge tone="neutral">Settlement status unavailable</Badge>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
