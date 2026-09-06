"use client";

import Link from "next/link";
import { formatAmount, formatDateTime, formatExactAmount } from "../../lib/format";
import { useMyPositions } from "../../lib/trading/hooks";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Skeleton } from "../ui/Skeleton";

export function PositionsTable() {
  const { data: positions, isLoading, isError, refetch } = useMyPositions();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Positions</CardTitle>
      </CardHeader>

      {isLoading && (
        <CardBody className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </CardBody>
      )}

      {isError && !isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load your positions.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {positions && !isLoading && positions.length === 0 && (
        <CardBody className="py-10 text-center text-sm text-white/50">You have no positions.</CardBody>
      )}

      {positions && !isLoading && positions.length > 0 && (
        <div className="divide-y divide-vault-border">
          {positions.map((position) => {
            const market = position.outcome?.market;
            return (
              <div key={position.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  {market ? (
                    <Link href={`/markets/${market.slug}`} className="truncate text-sm font-medium text-white hover:text-vault-gold">
                      {market.title}
                    </Link>
                  ) : (
                    <p className="truncate text-sm font-medium text-white">{position.marketId}</p>
                  )}
                  <p className="text-xs text-white/40">{position.outcome?.label ?? position.outcomeId}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm tabular-nums text-white">
                    {formatAmount(position.quantity)}
                    {Number(position.reservedQuantity) > 0 && (
                      <span className="text-white/40"> ({formatAmount(position.reservedQuantity)} reserved)</span>
                    )}
                  </p>
                  <p className="text-xs text-white/40">Avg. price {formatExactAmount(position.avgPrice)}</p>
                  {position.settledAt ? (
                    <Badge tone="gold" className="mt-1">
                      Settled {formatDateTime(position.settledAt)}
                    </Badge>
                  ) : Number(position.realizedPnl) !== 0 ? (
                    <p className={Number(position.realizedPnl) > 0 ? "text-xs text-vault-up" : "text-xs text-vault-down"}>
                      Realized P&amp;L {formatAmount(position.realizedPnl)}
                    </p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
