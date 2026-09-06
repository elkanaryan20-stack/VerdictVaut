"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { formatAmount, formatDateTime, formatExactAmount } from "../../lib/format";
import { useMyFills } from "../../lib/trading/hooks";
import { Badge } from "../ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";

const PAGE_SIZE = 10;

export function FillsTable() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, isPlaceholderData, refetch } = useMyFills({ page, pageSize: PAGE_SIZE });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fills</CardTitle>
      </CardHeader>

      {isLoading && (
        <CardBody className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardBody>
      )}

      {isError && !isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load your fills.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {data && !isLoading && data.items.length === 0 && (
        <CardBody className="py-10 text-center text-sm text-white/50">You have no fills yet.</CardBody>
      )}

      {data && !isLoading && data.items.length > 0 && (
        <div className={isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <div className="divide-y divide-vault-border">
            {data.items.map((fill) => (
              <div key={fill.fillId} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={fill.side === "BUY" ? "text-xs font-semibold text-vault-up" : "text-xs font-semibold text-vault-down"}>
                      {fill.side}
                    </span>
                    <span className="text-xs text-white/40">{formatDateTime(fill.executedAt)}</span>
                    {fill.isMaker && <Badge tone="neutral">Maker</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-white/40">
                    {formatAmount(fill.quantity)} @ {formatExactAmount(fill.price)}
                    {Number(fill.fee) > 0 && <> · fee {formatAmount(fill.fee)}</>}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between border-t border-vault-border px-5 py-3">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-white/70 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Previous
            </button>
            <p className="text-xs text-white/40">
              Page {data.page} of {totalPages}
            </p>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-white/70 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-30"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
