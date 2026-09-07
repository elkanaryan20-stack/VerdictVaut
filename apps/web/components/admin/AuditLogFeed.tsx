"use client";

import { useAuditLogs } from "../../lib/admin/hooks";
import { formatDateTime, truncateMiddle } from "../../lib/format";
import { Badge } from "../ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";

/**
 * GET /admin/audit-logs — read-only, ADMIN or SUPER_ADMIN (see
 * AdminController's class-level @Roles). Purely observational: this
 * component never triggers a mutation.
 */
export function AuditLogFeed() {
  const { data: entries, isLoading, isError, refetch } = useAuditLogs();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
      </CardHeader>

      {isLoading && (
        <CardBody className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardBody>
      )}

      {isError && !isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load the audit log.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {entries && !isLoading && entries.length === 0 && (
        <CardBody className="py-8 text-center text-sm text-white/50">No audit log entries yet.</CardBody>
      )}

      {entries && !isLoading && entries.length > 0 && (
        <div className="max-h-96 divide-y divide-vault-border overflow-y-auto">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-start justify-between gap-3 px-5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white">{entry.action}</p>
                <p className="text-xs text-white/40">
                  {entry.resourceType}
                  {entry.resourceId && <> · {truncateMiddle(entry.resourceId, 6, 4)}</>}
                  {entry.reason && <> · {entry.reason}</>}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <Badge tone={entry.actorType === "SYSTEM" ? "neutral" : entry.actorType === "ADMIN" ? "info" : "gold"}>
                  {entry.actorType}
                </Badge>
                <p className="mt-1 text-[11px] text-white/30">{formatDateTime(entry.createdAt)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
