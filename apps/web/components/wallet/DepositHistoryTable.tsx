"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { formatAmount, formatDateTime, truncateMiddle } from "../../lib/format";
import { useDeposits } from "../../lib/wallet/hooks";
import { DepositStatusBadge } from "./DepositStatusBadge";

const PAGE_SIZE = 10;

export function DepositHistoryTable() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, isPlaceholderData, refetch } = useDeposits(page, PAGE_SIZE);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deposit history</CardTitle>
        {data && data.total > 0 && (
          <p className="text-xs text-white/40">
            {data.total} deposit{data.total === 1 ? "" : "s"}
          </p>
        )}
      </CardHeader>

      {isLoading && (
        <CardBody className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </CardBody>
      )}

      {isError && !isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load your deposit history.</p>
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
        <CardBody className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="text-sm font-medium text-white">No deposits yet</p>
          <p className="max-w-xs text-xs text-white/40">Once you send funds to one of your deposit addresses, it will show up here.</p>
        </CardBody>
      )}

      {data && !isLoading && data.items.length > 0 && (
        <div className={isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-vault-border text-left text-xs uppercase tracking-wide text-white/40">
                  <th className="px-5 py-3 font-medium">Asset / Network</th>
                  <th className="px-5 py-3 font-medium text-right">Amount</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Detected</th>
                  <th className="px-5 py-3 font-medium">Tx</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((deposit) => (
                  <tr key={deposit.id} className="border-b border-vault-border/60 last:border-0 hover:bg-white/[0.02]">
                    <td className="px-5 py-3">
                      <Link href={`/wallet/deposits/${deposit.id}`} className="font-medium text-white hover:text-vault-gold">
                        {deposit.assetNetwork?.asset.symbol ?? "—"}
                      </Link>
                      <p className="text-xs text-white/40">{deposit.assetNetwork?.network.name ?? ""}</p>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-white">{formatAmount(deposit.amount)}</td>
                    <td className="px-5 py-3">
                      <DepositStatusBadge status={deposit.status} />
                    </td>
                    <td className="px-5 py-3 text-white/60">{formatDateTime(deposit.detectedAt)}</td>
                    <td className="px-5 py-3 font-mono text-xs text-white/40">{truncateMiddle(deposit.txHash)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile stacked cards */}
          <div className="divide-y divide-vault-border md:hidden">
            {data.items.map((deposit) => (
              <Link
                key={deposit.id}
                href={`/wallet/deposits/${deposit.id}`}
                className="block px-5 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-vault-gold"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="shrink-0 font-medium text-white">{deposit.assetNetwork?.asset.symbol ?? "—"}</p>
                  <p className="min-w-0 truncate text-right tabular-nums text-white">{formatAmount(deposit.amount)}</p>
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <DepositStatusBadge status={deposit.status} />
                  <p className="text-xs text-white/40">{formatDateTime(deposit.detectedAt)}</p>
                </div>
              </Link>
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
