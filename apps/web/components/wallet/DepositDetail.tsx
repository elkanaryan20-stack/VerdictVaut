"use client";

import Link from "next/link";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { CopyButton } from "../ui/CopyButton";
import { formatDateTime, formatExactAmount, truncateMiddle } from "../../lib/format";
import { useDeposit } from "../../lib/wallet/hooks";
import { DEPOSIT_STATUS_DESCRIPTION, isTerminalDepositStatus } from "../../lib/wallet/deposit-status";
import { DepositStatusBadge } from "./DepositStatusBadge";
import { ConfirmationProgress } from "./ConfirmationProgress";
import { ApiError } from "../../lib/api-client";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-vault-border/60 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-xs uppercase tracking-wide text-white/40">{label}</dt>
      <dd className="text-sm text-white sm:text-right">{children}</dd>
    </div>
  );
}

export function DepositDetail({ depositId }: { depositId: string }) {
  const { data: deposit, isLoading, isError, error, refetch } = useDeposit(depositId);

  return (
    <div className="space-y-4">
      <Link href="/wallet/deposits" className="inline-flex items-center gap-1.5 text-sm text-white/60 hover:text-white">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to deposit history
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>Deposit details</CardTitle>
          {deposit && <DepositStatusBadge status={deposit.status} />}
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
                ? "This deposit doesn't exist, or doesn't belong to your account."
                : "Couldn't load this deposit."}
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

        {deposit && !isLoading && (
          <CardBody className="space-y-5">
            <p className="text-sm text-white/60">{DEPOSIT_STATUS_DESCRIPTION[deposit.status]}</p>

            {!isTerminalDepositStatus(deposit.status) && (
              <ConfirmationProgress confirmations={deposit.confirmations} requiredConfirmations={deposit.requiredConfirmations} />
            )}

            {deposit.status === "FAILED" && (
              <div className="flex items-start gap-2 rounded-lg border border-vault-down/30 bg-vault-down/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-vault-down" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-vault-down">This deposit needs attention</p>
                  <p className="mt-0.5 text-xs text-white/60">
                    {deposit.failureReason ?? "This deposit could not be processed automatically."} If you believe this is an error,
                    please contact support with this deposit&apos;s reference below.
                  </p>
                </div>
              </div>
            )}

            {deposit.status === "REJECTED" && (
              <div className="flex items-start gap-2 rounded-lg border border-vault-down/30 bg-vault-down/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-vault-down" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-vault-down">This deposit was rejected</p>
                  <p className="mt-0.5 text-xs text-white/60">
                    {deposit.failureReason ?? "The blockchain no longer shows this transaction as valid."} No funds were credited for
                    this deposit.
                  </p>
                </div>
              </div>
            )}

            <dl>
              <Row label="Asset">{deposit.assetNetwork?.asset.symbol ?? "—"}</Row>
              <Row label="Network">{deposit.assetNetwork?.network.name ?? "—"}</Row>
              <Row label="Amount">
                {formatExactAmount(deposit.amount)} {deposit.assetNetwork?.asset.symbol ?? ""}
              </Row>
              {deposit.destinationTag && <Row label="Destination tag">{deposit.destinationTag}</Row>}
              <Row label="Transaction">
                <span className="inline-flex items-center gap-2">
                  <code className="break-all font-mono text-xs">{truncateMiddle(deposit.txHash, 10, 8)}</code>
                  <CopyButton value={deposit.txHash} label="Copy" />
                </span>
              </Row>
              <Row label="Detected">{formatDateTime(deposit.detectedAt)}</Row>
              {deposit.confirmedAt && <Row label="Confirmed">{formatDateTime(deposit.confirmedAt)}</Row>}
              {deposit.creditedAt && <Row label="Credited">{formatDateTime(deposit.creditedAt)}</Row>}
              <Row label="Reference">
                <code className="font-mono text-xs text-white/50">{deposit.id}</code>
              </Row>
            </dl>
          </CardBody>
        )}
      </Card>
    </div>
  );
}
