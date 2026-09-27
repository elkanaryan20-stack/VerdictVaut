"use client";

import type { ScheduledJobState } from "@verdictvaut/shared-types";
import { useOpenDiscrepancies, useScheduledJobs, useStaleWithdrawals } from "../../lib/admin/hooks";
import { ApiError } from "../../lib/api-client";
import { formatDateTime, formatExactAmount, truncateMiddle } from "../../lib/format";
import { Badge } from "../ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";
import { WithdrawalStatusBadge } from "../wallet/WithdrawalStatusBadge";

/**
 * Phase 36 — read-only operator views over the Phase 35 operational
 * endpoints (all ADMIN-readable server-side): withdrawals that stopped
 * progressing, worker background-job health, and open reconciliation
 * discrepancies. Deliberately NO controls: every recovery action
 * (manual broadcast, declare/resolve ambiguous execution, discrepancy
 * acknowledge/resolve) needs out-of-band evidence and is performed through
 * the audited admin API per docs/operations-runbook.md §13–§15 — a button
 * here would invite acting without that evidence. Raw timestamps and
 * states are shown as-is; no staleness threshold is invented client-side.
 */
export function OperationsStatus() {
  return (
    <div className="space-y-6">
      <StaleWithdrawalsCard />
      <ScheduledJobsCard />
      <OpenDiscrepanciesCard />
    </div>
  );
}

function LoadingRows() {
  return (
    <CardBody className="space-y-3" aria-busy="true">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </CardBody>
  );
}

function ErrorRow({ what, error, onRetry }: { what: string; error: unknown; onRetry: () => void }) {
  return (
    <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
      <p role="alert">
        Couldn&apos;t load {what}.{error instanceof ApiError && error.status === 403 ? " Your role does not have access to this view." : ""}
      </p>
      <button type="button" onClick={onRetry} className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5">
        Retry
      </button>
    </CardBody>
  );
}

function StaleWithdrawalsCard() {
  const { data, isLoading, isError, error, refetch } = useStaleWithdrawals();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Withdrawals not progressing</CardTitle>
      </CardHeader>
      <CardBody className="border-b border-vault-border py-2.5 text-xs text-white/50">
        Unfinished withdrawals with no state change in the last hour. Recovery follows the stuck-withdrawal runbook (§13) through the audited admin API.
      </CardBody>
      {isLoading && <LoadingRows />}
      {isError && !isLoading && <ErrorRow what="stale withdrawals" error={error} onRetry={() => refetch()} />}
      {data && data.length === 0 && <CardBody className="py-6 text-center text-sm text-white/50">No stale withdrawals.</CardBody>}
      {data && data.length > 0 && (
        <div className="divide-y divide-vault-border">
          {data.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-white">
                  {formatExactAmount(w.amount)} {w.assetNetwork.asset.symbol} on {w.assetNetwork.network.name}
                </p>
                <p className="mt-0.5 text-xs text-white/40">
                  {w.user.email} · last change {formatDateTime(w.updatedAt)} · <span className="font-mono">{truncateMiddle(w.id)}</span>
                </p>
              </div>
              <WithdrawalStatusBadge status={w.status} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function jobState(job: ScheduledJobState): { label: string; tone: "up" | "down" | "gold" | "neutral" } {
  if (job.lockedAt) return { label: "Running", tone: "gold" };
  const lastError = job.lastErrorAt ? Date.parse(job.lastErrorAt) : null;
  const lastSuccess = job.lastSuccessAt ? Date.parse(job.lastSuccessAt) : null;
  if (lastError !== null && (lastSuccess === null || lastError > lastSuccess)) return { label: "Last run failed", tone: "down" };
  if (lastSuccess !== null) return { label: "Last run succeeded", tone: "up" };
  return { label: "Never completed", tone: "neutral" };
}

function jobLabel(jobKey: string): string {
  if (jobKey === "withdrawal-watcher") return "Withdrawal watcher (worker heartbeat)";
  if (jobKey === "collateral-reconciliation") return "Market collateral reconciliation";
  if (jobKey.startsWith("independent-reconciliation:")) return `Chain reconciliation · ${truncateMiddle(jobKey.slice("independent-reconciliation:".length))}`;
  return jobKey;
}

function ScheduledJobsCard() {
  const { data, isLoading, isError, error, refetch } = useScheduledJobs();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Background jobs</CardTitle>
      </CardHeader>
      {isLoading && <LoadingRows />}
      {isError && !isLoading && <ErrorRow what="background job status" error={error} onRetry={() => refetch()} />}
      {data && data.length === 0 && (
        <CardBody className="py-6 text-center text-sm text-white/50">
          No background job has reported yet — the worker&apos;s watchers/scheduler may be disabled or not running.
        </CardBody>
      )}
      {data && data.length > 0 && (
        <div className="divide-y divide-vault-border">
          {data.map((job) => {
            const state = jobState(job);
            return (
              <div key={job.jobKey} className="flex flex-wrap items-start justify-between gap-2 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white">{jobLabel(job.jobKey)}</p>
                  <p className="mt-0.5 text-xs text-white/40">
                    Last started {job.lastStartedAt ? formatDateTime(job.lastStartedAt) : "never"} · last success{" "}
                    {job.lastSuccessAt ? formatDateTime(job.lastSuccessAt) : "never"}
                  </p>
                  {state.tone === "down" && job.lastError && <p className="mt-0.5 break-words text-xs text-vault-down">{job.lastError}</p>}
                </div>
                <Badge tone={state.tone}>{state.label}</Badge>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function OpenDiscrepanciesCard() {
  const { data, isLoading, isError, error, refetch } = useOpenDiscrepancies();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Open reconciliation discrepancies</CardTitle>
      </CardHeader>
      {isLoading && <LoadingRows />}
      {isError && !isLoading && <ErrorRow what="reconciliation discrepancies" error={error} onRetry={() => refetch()} />}
      {data && data.length === 0 && <CardBody className="py-6 text-center text-sm text-white/50">No open discrepancies.</CardBody>}
      {data && data.length > 0 && (
        <div className="divide-y divide-vault-border">
          {data.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div className="min-w-0">
                <p className="text-sm text-white">{d.type.replace(/_/g, " ")}</p>
                <p className="mt-0.5 text-xs text-white/40">
                  {d.internalEntityType ? `${d.internalEntityType} ${truncateMiddle(d.internalEntityId ?? "")} · ` : ""}
                  <span className="font-mono">{truncateMiddle(d.chainIdentity)}</span> · {formatDateTime(d.createdAt)}
                </p>
              </div>
              <Badge tone={d.severity === "CRITICAL" ? "down" : d.severity === "WARNING" ? "gold" : "neutral"}>{d.severity}</Badge>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
