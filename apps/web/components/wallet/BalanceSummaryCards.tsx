"use client";

import { SETTLEMENT_ASSET_SYMBOL } from "@verdictvaut/shared-types";
import { Card, CardBody } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { formatAmount } from "../../lib/format";
import { useBalances } from "../../lib/wallet/hooks";

function StatCard({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: "gold" | "up" | "default" }) {
  return (
    <Card>
      <CardBody>
        <p className="text-xs font-medium uppercase tracking-wide text-white/50">{label}</p>
        <p
          className={
            "mt-2 font-display text-2xl font-semibold tabular-nums " +
            (tone === "gold" ? "text-vault-gold" : tone === "up" ? "text-vault-up" : "text-white")
          }
        >
          {value}
        </p>
        {hint && <p className="mt-1 text-xs text-white/40">{hint}</p>}
      </CardBody>
    </Card>
  );
}

function StatCardSkeleton() {
  return (
    <Card>
      <CardBody>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-7 w-32" />
        <Skeleton className="mt-2 h-3 w-20" />
      </CardBody>
    </Card>
  );
}

/**
 * The headline numbers use the settlement currency (USDC — see
 * SETTLEMENT_ASSET_SYMBOL) as the featured figure, never a blended
 * cross-asset total: this system has no price/FX conversion anywhere, so
 * summing BTC + ETH + USDC into one number would mean fabricating an
 * exchange rate. The full per-asset breakdown lives in AssetBalanceTable
 * below this.
 */
export function BalanceSummaryCards() {
  const { data: balances, isLoading, isError } = useBalances();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
    );
  }

  if (isError || !balances) {
    return (
      <Card>
        <CardBody className="text-sm text-white/60">Balances are temporarily unavailable. Try refreshing the page.</CardBody>
      </Card>
    );
  }

  const settlement = balances.find((b) => b.symbol === SETTLEMENT_ASSET_SYMBOL);
  const assetsWithBalance = balances.filter((b) => Number(b.totalBalance) > 0 || Number(b.reservedBalance) > 0).length;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <StatCard
        label={`${SETTLEMENT_ASSET_SYMBOL} — Available`}
        value={settlement ? formatAmount(settlement.availableBalance) : "—"}
        hint="Free to trade or withdraw"
        tone="up"
      />
      <StatCard
        label={`${SETTLEMENT_ASSET_SYMBOL} — Reserved`}
        value={settlement ? formatAmount(settlement.reservedBalance) : "—"}
        hint="Locked by open orders"
      />
      <StatCard
        label={`${SETTLEMENT_ASSET_SYMBOL} — Total`}
        value={settlement ? formatAmount(settlement.totalBalance) : "—"}
        hint={`${assetsWithBalance} of ${balances.length} assets funded`}
        tone="gold"
      />
    </div>
  );
}
