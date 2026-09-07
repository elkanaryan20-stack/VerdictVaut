"use client";

import { useState } from "react";
import { useApproveWithdrawal, useAdminWithdrawals, useReconcileWithdrawal, useRejectWithdrawal } from "../../lib/admin/hooks";
import { ApiError } from "../../lib/api-client";
import { formatDateTime, formatExactAmount, truncateMiddle } from "../../lib/format";
import { useAuth } from "../../lib/auth/auth-context";
import { WithdrawalStatusBadge } from "../wallet/WithdrawalStatusBadge";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Dialog } from "../ui/Dialog";
import { Skeleton } from "../ui/Skeleton";
import { TextField } from "../ui/TextField";

// Mirrors WithdrawalsService's own CAS-guarded allowed-from sets exactly
// (see withdrawals.service.ts: approve() casTransition([RISK_REVIEW]),
// reject() allowedFrom [REQUESTED, RISK_REVIEW, APPROVED]) — these are UX
// gates only, the backend re-enforces the real transition legality itself.
const APPROVABLE = new Set(["RISK_REVIEW"]);
const REJECTABLE = new Set(["REQUESTED", "RISK_REVIEW", "APPROVED"]);

/**
 * ADMIN and SUPER_ADMIN can both view this (GET /admin/withdrawals is
 * only class-level @Roles(ADMIN, SUPER_ADMIN)). Approve/reject/reconcile
 * are SUPER_ADMIN-only server-side (@Roles(SUPER_ADMIN) overrides the
 * class default on each — see AdminController); this component only
 * ever shows those controls for a SUPER_ADMIN, but that is a UX
 * convenience, not the security boundary — the backend rejects the call
 * from anyone else regardless.
 */
export function AdminWithdrawalsTable() {
  const { user } = useAuth();
  const canDecide = user?.role === "SUPER_ADMIN";
  const withdrawalsQuery = useAdminWithdrawals();
  const approveMutation = useApproveWithdrawal();
  const rejectMutation = useRejectWithdrawal();
  const reconcileMutation = useReconcileWithdrawal();

  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [reconciledId, setReconciledId] = useState<string | null>(null);

  const withdrawals = withdrawalsQuery.data ?? [];
  const reconcileReport = reconcileMutation.data;

  function handleApprove() {
    if (!approvingId) return;
    approveMutation.mutate(approvingId, { onSuccess: () => setApprovingId(null) });
  }

  function handleReject() {
    if (!rejectingId || !rejectReason.trim()) return;
    rejectMutation.mutate(
      { withdrawalId: rejectingId, reason: rejectReason.trim() },
      { onSuccess: () => { setRejectingId(null); setRejectReason(""); } },
    );
  }

  function handleReconcile(withdrawalId: string) {
    setReconciledId(withdrawalId);
    reconcileMutation.mutate(withdrawalId);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Withdrawals</CardTitle>
      </CardHeader>

      {withdrawalsQuery.isLoading && (
        <CardBody className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </CardBody>
      )}

      {withdrawalsQuery.isError && !withdrawalsQuery.isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load withdrawals.</p>
          <button
            type="button"
            onClick={() => withdrawalsQuery.refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {!withdrawalsQuery.isLoading && !withdrawalsQuery.isError && withdrawals.length === 0 && (
        <CardBody className="py-8 text-center text-sm text-white/50">No withdrawals have been requested yet.</CardBody>
      )}

      {!withdrawalsQuery.isLoading && !withdrawalsQuery.isError && withdrawals.length > 0 && (
        <div className="divide-y divide-vault-border">
          {withdrawals.slice(0, 50).map((withdrawal) => (
            <div key={withdrawal.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm text-white">{withdrawal.user.email}</span>
                  <WithdrawalStatusBadge status={withdrawal.status} />
                  {withdrawal.complianceDecision === "DEFERRED" && <Badge tone="neutral">Compliance deferred</Badge>}
                </div>
                <p className="mt-1 text-xs text-white/40">
                  {formatExactAmount(withdrawal.amount)} {withdrawal.assetNetwork.asset.symbol} on {withdrawal.assetNetwork.network.name} to{" "}
                  {truncateMiddle(withdrawal.destinationAddress)}
                  {withdrawal.destinationTag && <> (tag {withdrawal.destinationTag})</>} · {formatDateTime(withdrawal.createdAt)}
                </p>
                {withdrawal.txHash && <p className="mt-0.5 font-mono text-[11px] text-white/30">tx {truncateMiddle(withdrawal.txHash, 10, 8)}</p>}

                {reconciledId === withdrawal.id && reconcileReport && reconcileReport.withdrawal.id === withdrawal.id && (
                  <div
                    className={`mt-2 rounded-md border px-2.5 py-1.5 text-xs ${
                      reconcileReport.discrepancy ? "border-vault-down/30 bg-vault-down/5 text-vault-down" : "border-vault-up/30 bg-vault-up/5 text-vault-up"
                    }`}
                  >
                    {reconcileReport.discrepancy
                      ? reconcileReport.note
                      : reconcileReport.chainStatus
                        ? `Chain confirms: ${reconcileReport.chainStatus.status}, ${reconcileReport.chainStatus.confirmations} confirmations.`
                        : "No transaction hash recorded yet — nothing to check on-chain."}
                  </div>
                )}
                {reconciledId === withdrawal.id && reconcileMutation.isError && (
                  <p role="alert" className="mt-2 text-xs text-vault-down">
                    {reconcileMutation.error instanceof ApiError ? reconcileMutation.error.message : "Couldn't reconcile this withdrawal."}
                  </p>
                )}
              </div>

              {canDecide && (
                <div className="flex shrink-0 flex-wrap gap-2">
                  {APPROVABLE.has(withdrawal.status) && (
                    <Button type="button" size="sm" onClick={() => setApprovingId(withdrawal.id)}>
                      Approve
                    </Button>
                  )}
                  {REJECTABLE.has(withdrawal.status) && (
                    <Button type="button" variant="danger" size="sm" onClick={() => setRejectingId(withdrawal.id)}>
                      Reject
                    </Button>
                  )}
                  {withdrawal.txHash && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => handleReconcile(withdrawal.id)}
                      isLoading={reconcileMutation.isPending && reconciledId === withdrawal.id}
                    >
                      Reconcile
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(approvingId)}
        onOpenChange={(open) => !open && setApprovingId(null)}
        title="Approve this withdrawal?"
        description="This authorizes execution via the configured custody executor. In sandbox, funds are never actually broadcast automatically — an admin still broadcasts manually and records the tx hash."
      >
        <div className="flex flex-col gap-3">
          {approveMutation.isError && (
            <p role="alert" className="rounded-md border border-vault-down/30 bg-vault-down/5 px-3 py-2 text-sm text-vault-down">
              {approveMutation.error instanceof ApiError ? approveMutation.error.message : "Approval failed."}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setApprovingId(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleApprove} isLoading={approveMutation.isPending}>
              Approve withdrawal
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(rejectingId)}
        onOpenChange={(open) => { if (!open) { setRejectingId(null); setRejectReason(""); } }}
        title="Reject this withdrawal?"
        description="The user's reserved funds are released back to their available balance immediately."
      >
        <div className="flex flex-col gap-3">
          <TextField label="Reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Explain why this withdrawal is being rejected" />
          {rejectMutation.isError && (
            <p role="alert" className="rounded-md border border-vault-down/30 bg-vault-down/5 px-3 py-2 text-sm text-vault-down">
              {rejectMutation.error instanceof ApiError ? rejectMutation.error.message : "Rejection failed."}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => { setRejectingId(null); setRejectReason(""); }}>
              Cancel
            </Button>
            <Button type="button" variant="danger" onClick={handleReject} isLoading={rejectMutation.isPending} disabled={!rejectReason.trim()}>
              Reject withdrawal
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
