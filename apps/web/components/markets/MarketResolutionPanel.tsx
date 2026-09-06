"use client";

import type { Market } from "@verdictvaut/shared-types";
import { useAuth } from "../../lib/auth/auth-context";
import { formatAmount, formatDateTime } from "../../lib/format";
import { useMarketResolutionStatus, useMySettlement } from "../../lib/trading/hooks";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";

/** Only rendered by the parent for RESOLVING/RESOLVED markets — see MarketDetail. */
export function MarketResolutionPanel({ market }: { market: Market }) {
  const { status: authStatus } = useAuth();
  const resolutionQuery = useMarketResolutionStatus(market.id, true);
  const settlementQuery = useMySettlement(market.id, authStatus === "authenticated");

  const outcomeLabel = (outcomeId: string) => market.outcomes.find((o) => o.id === outcomeId)?.label ?? outcomeId;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Resolution</CardTitle>
      </CardHeader>

      {resolutionQuery.isLoading && (
        <CardBody className="space-y-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </CardBody>
      )}

      {resolutionQuery.isError && !resolutionQuery.isLoading && (
        <CardBody className="text-sm text-white/60">Couldn&apos;t load resolution status.</CardBody>
      )}

      {resolutionQuery.data && !resolutionQuery.isLoading && (
        <CardBody className="space-y-3 text-sm">
          {resolutionQuery.data.resolution ? (
            <>
              <p className="text-white">
                Winning outcome: <span className="font-semibold text-vault-gold">{resolutionQuery.data.resolution.winningOutcomeKey}</span>
              </p>
              <p className="text-xs text-white/40">Resolved {formatDateTime(resolutionQuery.data.resolution.resolvedAt)}</p>
              {resolutionQuery.data.resolution.notes && <p className="text-xs text-white/50">{resolutionQuery.data.resolution.notes}</p>}
              <p className="text-xs text-white/40">
                Settlement: {resolutionQuery.data.settlement.settledPositions} of {resolutionQuery.data.settlement.totalPositions} positions settled
              </p>
            </>
          ) : (
            <p className="text-white/60">This market has not been resolved yet.</p>
          )}

          {authStatus === "authenticated" && settlementQuery.data && settlementQuery.data.length > 0 && (
            <div className="border-t border-vault-border pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">Your settlement</p>
              <ul className="space-y-1">
                {settlementQuery.data.map((s) => (
                  <li key={s.id} className="flex items-center justify-between">
                    <span className="text-white/70">{outcomeLabel(s.outcomeId)}</span>
                    <span className="tabular-nums text-white">{formatAmount(s.payoutAmount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardBody>
      )}
    </Card>
  );
}
