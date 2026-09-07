"use client";

import { useState } from "react";
import { useReprocessDeposit, useAdminDeposits, useStaleDeposits } from "../../lib/admin/hooks";
import { ApiError } from "../../lib/api-client";
import { formatExactAmount, formatDateTime, truncateMiddle } from "../../lib/format";
import { useAuth } from "../../lib/auth/auth-context";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Dialog } from "../ui/Dialog";
import { Skeleton } from "../ui/Skeleton";
import { DepositStatusBadge } from "../wallet/DepositStatusBadge";

/**
 * ADMIN and SUPER_ADMIN can both view this (GET /admin/deposits and GET
 * /admin/deposits/stale are only class-level @Roles(ADMIN, SUPER_ADMIN)
 * — see AdminController). Reprocessing is SUPER_ADMIN-only server-side
 * (@Roles(SUPER_ADMIN) overrides the class default on that one route);
 * this component only ever shows the button for a SUPER_ADMIN, but that
 * is a UX convenience, not the security boundary — the backend would
 * reject the call from anyone else regardless.
 */
export function AdminDepositsTable() {
  const { user } = useAuth();
  const canReprocess = user?.role === "SUPER_ADMIN";
  const depositsQuery = useAdminDeposits();
  const staleQuery = useStaleDeposits();
  const reprocessMutation = useReprocessDeposit();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const isLoading = depositsQuery.isLoading;
  const isError = depositsQuery.isError;
  const deposits = depositsQuery.data ?? [];
  const staleIds = new Set((staleQuery.data ?? []).map((d) => d.id));

  function handleConfirmReprocess() {
    if (!confirmingId) return;
    reprocessMutation.mutate(confirmingId, {
      onSuccess: () => setConfirmingId(null),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deposits</CardTitle>
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
          <p>Couldn&apos;t load deposits.</p>
          <button
            type="button"
            onClick={() => depositsQuery.refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {!isLoading && !isError && deposits.length === 0 && (
        <CardBody className="py-8 text-center text-sm text-white/50">No deposits recorded yet.</CardBody>
      )}

      {!isLoading && !isError && deposits.length > 0 && (
        <div className="divide-y divide-vault-border overflow-x-auto">
          {deposits.slice(0, 50).map((deposit) => {
            const needsAttention = staleIds.has(deposit.id);
            return (
              <div key={deposit.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm text-white">{deposit.user.email}</span>
                    <DepositStatusBadge status={deposit.status} />
                    {needsAttention && <Badge tone="down">Needs attention</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-white/40">
                    {formatExactAmount(deposit.amount)} {deposit.assetNetwork.asset.symbol} on {deposit.assetNetwork.network.name} ·{" "}
                    {truncateMiddle(deposit.txHash)} · {formatDateTime(deposit.detectedAt)}
                  </p>
                </div>
                {canReprocess && (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmingId(deposit.id)}>
                    Reprocess
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={Boolean(confirmingId)}
        onOpenChange={(open) => !open && setConfirmingId(null)}
        title="Reprocess this deposit?"
        description="This re-checks the transaction directly on-chain and updates the deposit's status from what's actually there — it never accepts an amount or status from this dialog."
      >
        <div className="flex flex-col gap-3">
          {reprocessMutation.isError && (
            <p role="alert" className="rounded-md border border-vault-down/30 bg-vault-down/5 px-3 py-2 text-sm text-vault-down">
              {reprocessMutation.error instanceof ApiError ? reprocessMutation.error.message : "Reprocessing failed."}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirmingId(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleConfirmReprocess} isLoading={reprocessMutation.isPending}>
              Reprocess deposit
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
