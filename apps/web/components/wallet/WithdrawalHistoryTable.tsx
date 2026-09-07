"use client";

import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { formatAmount, formatDateTime, truncateMiddle } from "../../lib/format";
import { useWithdrawals } from "../../lib/wallet/hooks";
import { WithdrawalStatusBadge } from "./WithdrawalStatusBadge";

/** No pagination controls — GET /wallet/withdrawals isn't paginated on the backend (naturally bounded per user), so this never fakes a page count the API doesn't provide. */
export function WithdrawalHistoryTable() {
  const { data, isLoading, isError, refetch } = useWithdrawals();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Withdrawal history</CardTitle>
        {data && data.length > 0 && (
          <p className="text-xs text-white/40">
            {data.length} withdrawal{data.length === 1 ? "" : "s"}
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
          <p>Couldn&apos;t load your withdrawal history.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {data && !isLoading && data.length === 0 && (
        <CardBody className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="text-sm font-medium text-white">No withdrawals yet</p>
          <p className="max-w-xs text-xs text-white/40">Once you request a withdrawal, it will show up here.</p>
        </CardBody>
      )}

      {data && !isLoading && data.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-vault-border text-left text-xs uppercase tracking-wide text-white/40">
                  <th className="px-5 py-3 font-medium">Asset / Network</th>
                  <th className="px-5 py-3 font-medium text-right">Amount</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Requested</th>
                  <th className="px-5 py-3 font-medium">Tx</th>
                </tr>
              </thead>
              <tbody>
                {data.map((withdrawal) => (
                  <tr key={withdrawal.id} className="border-b border-vault-border/60 last:border-0 hover:bg-white/[0.02]">
                    <td className="px-5 py-3">
                      <Link href={`/wallet/withdrawals/${withdrawal.id}`} className="font-medium text-white hover:text-vault-gold">
                        {withdrawal.assetNetwork?.asset.symbol ?? "—"}
                      </Link>
                      <p className="text-xs text-white/40">{withdrawal.assetNetwork?.network.name ?? ""}</p>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-white">{formatAmount(withdrawal.amount)}</td>
                    <td className="px-5 py-3">
                      <WithdrawalStatusBadge status={withdrawal.status} />
                    </td>
                    <td className="px-5 py-3 text-white/60">{formatDateTime(withdrawal.createdAt)}</td>
                    <td className="px-5 py-3 font-mono text-xs text-white/40">{withdrawal.txHash ? truncateMiddle(withdrawal.txHash) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile stacked cards */}
          <div className="divide-y divide-vault-border md:hidden">
            {data.map((withdrawal) => (
              <Link
                key={withdrawal.id}
                href={`/wallet/withdrawals/${withdrawal.id}`}
                className="block px-5 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-vault-gold"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="shrink-0 font-medium text-white">{withdrawal.assetNetwork?.asset.symbol ?? "—"}</p>
                  <p className="min-w-0 truncate text-right tabular-nums text-white">{formatAmount(withdrawal.amount)}</p>
                </div>
                <div className="mt-1.5 flex items-center justify-between">
                  <WithdrawalStatusBadge status={withdrawal.status} />
                  <p className="text-xs text-white/40">{formatDateTime(withdrawal.createdAt)}</p>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
