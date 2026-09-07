"use client";

import Link from "next/link";
import { formatDateTime, formatExactAmount, truncateMiddle } from "../../lib/format";
import { useMySettlements } from "../../lib/trading/hooks";
import { Badge } from "../ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { CopyButton } from "../ui/CopyButton";
import { Skeleton } from "../ui/Skeleton";

/**
 * Cross-market settlement/payout history — every backend-recorded
 * PositionSettlement row for this user, win or lose. A zero payoutAmount
 * is a real, backend-computed outcome (a losing position still settles,
 * it just settles for nothing) and is shown as such, never hidden or
 * confused with a still-open position.
 */
export function SettlementHistoryTable() {
  const { items, isLoading, isError, hasPartialError, refetch } = useMySettlements();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settlement history</CardTitle>
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
          <p>Couldn&apos;t load your settlement history.</p>
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
        <CardBody className="py-10 text-center text-sm text-white/50">No settled positions yet.</CardBody>
      )}

      {!isLoading && !isError && items.length > 0 && (
        <>
          {hasPartialError && (
            <CardBody className="flex flex-wrap items-center justify-between gap-3 border-b border-vault-border bg-vault-down/5 py-3 text-xs text-white/60">
              <p role="alert">Some settlement data couldn&apos;t be loaded — the list below may be incomplete.</p>
              <button
                type="button"
                onClick={() => refetch()}
                className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
              >
                Retry
              </button>
            </CardBody>
          )}
          <div className="divide-y divide-vault-border">
            {items.map((settlement) => {
              const isPaid = Number(settlement.payoutAmount) > 0;
              return (
                <div key={settlement.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    {settlement.market ? (
                      <Link
                        href={`/markets/${settlement.market.slug}`}
                        className="truncate text-sm font-medium text-white hover:text-vault-gold"
                      >
                        {settlement.market.title}
                      </Link>
                    ) : (
                      <p className="truncate text-sm font-medium text-white">{settlement.marketId}</p>
                    )}
                    <p className="text-xs text-white/40">
                      Winning outcome: {settlement.outcome.label} · {formatDateTime(settlement.settledAt)}
                    </p>
                    {settlement.ledgerTransactionId && (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="text-[11px] text-white/30">Ledger ref {truncateMiddle(settlement.ledgerTransactionId)}</span>
                        <CopyButton value={settlement.ledgerTransactionId} label="Copy ledger ref" />
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={isPaid ? "text-sm font-semibold tabular-nums text-vault-up" : "text-sm font-semibold tabular-nums text-white/60"}>
                      {formatExactAmount(settlement.payoutAmount)}
                    </p>
                    <p className="text-xs text-white/40">
                      {formatExactAmount(settlement.quantity)} sh. @ {formatExactAmount(settlement.payoutPerShare)}
                    </p>
                    <Badge tone={isPaid ? "up" : "neutral"} className="mt-1">
                      {isPaid ? "Paid out" : "No payout"}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}
