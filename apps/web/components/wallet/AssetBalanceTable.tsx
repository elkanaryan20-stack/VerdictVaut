"use client";

import Link from "next/link";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { formatAmount } from "../../lib/format";
import { useBalances } from "../../lib/wallet/hooks";
import { AssetIcon } from "./AssetIcon";

export function AssetBalanceTable() {
  const { data: balances, isLoading, isError, refetch } = useBalances();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Asset balances</CardTitle>
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
          <p>Couldn&apos;t load asset balances.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {balances && !isLoading && (
        <>
          {/* Desktop / wide: table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-vault-border text-left text-xs uppercase tracking-wide text-white/40">
                  <th className="px-5 py-3 font-medium">Asset</th>
                  <th className="px-5 py-3 font-medium text-right">Total</th>
                  <th className="px-5 py-3 font-medium text-right">Available</th>
                  <th className="px-5 py-3 font-medium text-right">Reserved</th>
                  <th className="px-5 py-3 font-medium text-right">Deposit</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((asset) => (
                  <tr key={asset.assetId} className="border-b border-vault-border/60 last:border-0">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <AssetIcon symbol={asset.symbol} size={28} />
                        <div>
                          <p className="font-medium text-white">{asset.symbol}</p>
                          <p className="text-xs text-white/40">{asset.name}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-right tabular-nums text-white">{formatAmount(asset.totalBalance)}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-vault-up">{formatAmount(asset.availableBalance)}</td>
                    <td className="px-5 py-3 text-right tabular-nums text-white/60">{formatAmount(asset.reservedBalance)}</td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        href={`/wallet/deposit?asset=${asset.symbol}`}
                        className="text-xs font-medium text-vault-gold hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-vault-gold"
                      >
                        Deposit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: stacked cards */}
          <div className="divide-y divide-vault-border md:hidden">
            {balances.map((asset) => (
              <div key={asset.assetId} className="flex items-center justify-between gap-3 px-5 py-4">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <AssetIcon symbol={asset.symbol} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-white">{asset.symbol}</p>
                    <p className="truncate text-xs text-white/40">
                      Available <span className="text-vault-up">{formatAmount(asset.availableBalance)}</span>
                      {Number(asset.reservedBalance) > 0 && (
                        <>
                          {" "}
                          · Reserved <span className="text-white/60">{formatAmount(asset.reservedBalance)}</span>
                        </>
                      )}
                    </p>
                  </div>
                </div>
                <Link
                  href={`/wallet/deposit?asset=${asset.symbol}`}
                  className="shrink-0 rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-vault-gold hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-vault-gold"
                >
                  Deposit
                </Link>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
