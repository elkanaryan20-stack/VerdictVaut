"use client";

import Link from "next/link";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { CopyButton } from "../ui/CopyButton";
import { Button } from "../ui/Button";
import { formatDateTime, formatExactAmount, truncateMiddle } from "../../lib/format";
import { subtractDecimalStrings } from "../../lib/wallet/decimal";
import { useCancelWithdrawal, useWithdrawal } from "../../lib/wallet/hooks";
import { isCancellableWithdrawalStatus, WITHDRAWAL_STATUS_DESCRIPTION } from "../../lib/wallet/withdrawal-status";
import { WithdrawalStatusBadge } from "./WithdrawalStatusBadge";
import { ApiError } from "../../lib/api-client";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-vault-border/60 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-xs uppercase tracking-wide text-white/40">{label}</dt>
      <dd className="text-sm text-white sm:text-right">{children}</dd>
    </div>
  );
}

export function WithdrawalDetail({ withdrawalId }: { withdrawalId: string }) {
  const { data: withdrawal, isLoading, isError, error, refetch } = useWithdrawal(withdrawalId);
  const cancelMutation = useCancelWithdrawal();

  return (
    <div className="space-y-4">
      <Link href="/wallet/withdrawals" className="inline-flex items-center gap-1.5 text-sm text-white/60 hover:text-white">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to withdrawal history
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Withdrawal details</CardTitle>
          {withdrawal && <WithdrawalStatusBadge status={withdrawal.status} />}
        </CardHeader>

        {isLoading && (
          <CardBody className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardBody>
        )}

        {isError && !isLoading && (
          <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
            <p>
              {error instanceof ApiError && error.isNotFound
                ? "This withdrawal doesn't exist, or doesn't belong to your account."
                : "Couldn't load this withdrawal."}
            </p>
            {!(error instanceof ApiError && error.isNotFound) && (
              <button
                type="button"
                onClick={() => refetch()}
                className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
              >
                Retry
              </button>
            )}
          </CardBody>
        )}

        {withdrawal && !isLoading && (
          <CardBody className="space-y-5">
            <p className="text-sm text-white/60">{WITHDRAWAL_STATUS_DESCRIPTION[withdrawal.status]}</p>

            {(withdrawal.status === "FAILED" || withdrawal.status === "REJECTED") && (
              <div className="flex items-start gap-2 rounded-lg border border-vault-down/30 bg-vault-down/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-vault-down" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-vault-down">
                    This withdrawal was {withdrawal.status === "FAILED" ? "unable to complete" : "rejected"}
                  </p>
                  <p className="mt-0.5 text-xs text-white/60">
                    {withdrawal.failureReason ?? "No reason was recorded."} Your reserved funds have been released back to your available
                    balance.
                  </p>
                </div>
              </div>
            )}

            {isCancellableWithdrawalStatus(withdrawal.status) && (
              <div className="flex flex-col items-start gap-2 rounded-lg border border-vault-border bg-white/[0.02] p-3">
                <p className="text-xs text-white/60">
                  This withdrawal hasn&apos;t been reviewed yet — you can still cancel it and release your reserved funds.
                </p>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => cancelMutation.mutate(withdrawalId)}
                  isLoading={cancelMutation.isPending}
                >
                  Cancel withdrawal
                </Button>
                {cancelMutation.isError && (
                  <p role="alert" className="text-xs text-vault-down">
                    {cancelMutation.error instanceof ApiError ? cancelMutation.error.message : "Couldn't cancel this withdrawal."}
                  </p>
                )}
              </div>
            )}

            <dl>
              <Row label="Asset">{withdrawal.assetNetwork?.asset.symbol ?? "—"}</Row>
              <Row label="Network">{withdrawal.assetNetwork?.network.name ?? "—"}</Row>
              <Row label="Amount">{formatExactAmount(withdrawal.amount)}</Row>
              {Number(withdrawal.fee) > 0 && <Row label="Fee">{formatExactAmount(withdrawal.fee)}</Row>}
              <Row label="Estimated received">{formatExactAmount(subtractDecimalStrings(withdrawal.amount, withdrawal.fee))}</Row>
              <Row label="Destination">
                <code className="break-all font-mono text-xs">{withdrawal.destinationAddress}</code>
              </Row>
              {withdrawal.destinationTag && <Row label="Destination tag">{withdrawal.destinationTag}</Row>}
              {withdrawal.txHash && (
                <Row label="Transaction">
                  <span className="inline-flex items-center gap-2">
                    <code className="break-all font-mono text-xs">{truncateMiddle(withdrawal.txHash, 10, 8)}</code>
                    <CopyButton value={withdrawal.txHash} label="Copy" />
                  </span>
                </Row>
              )}
              <Row label="Requested">{formatDateTime(withdrawal.createdAt)}</Row>
              {withdrawal.broadcastAt && <Row label="Broadcast">{formatDateTime(withdrawal.broadcastAt)}</Row>}
              {withdrawal.confirmedAt && <Row label="Confirmed">{formatDateTime(withdrawal.confirmedAt)}</Row>}
              <Row label="Reference">
                <code className="font-mono text-xs text-white/50">{withdrawal.id}</code>
              </Row>
            </dl>
          </CardBody>
        )}
      </Card>
    </div>
  );
}
