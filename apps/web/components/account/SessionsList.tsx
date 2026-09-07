"use client";

import { CheckCircle2, Clock, XCircle } from "lucide-react";
import { useRevokeSession, useSessions } from "../../lib/account/hooks";
import { ApiError } from "../../lib/api-client";
import { formatDateTime } from "../../lib/format";
import { Badge, BadgeTone } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";

type SessionState = "active" | "revoked" | "expired";

function sessionState(session: { revokedAt: string | null; expiresAt: string }): SessionState {
  if (session.revokedAt) return "revoked";
  if (new Date(session.expiresAt) < new Date()) return "expired";
  return "active";
}

const STATE_TONE: Record<SessionState, BadgeTone> = { active: "up", revoked: "neutral", expired: "neutral" };
const STATE_LABEL: Record<SessionState, string> = { active: "Active", revoked: "Revoked", expired: "Expired" };
const STATE_ICON = { active: CheckCircle2, revoked: XCircle, expired: Clock };

/**
 * The backend's RefreshToken row has no device/IP/user-agent column (see
 * Session's docblock), so a session here is identified only by when it
 * was created — never a fabricated "Chrome on Windows" label this app
 * has no way to actually know.
 */
export function SessionsList() {
  const { data: sessions, isLoading, isError, refetch } = useSessions();
  const revokeMutation = useRevokeSession();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
      </CardHeader>

      {isLoading && (
        <CardBody className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardBody>
      )}

      {isError && !isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load your sessions.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {sessions && !isLoading && sessions.length === 0 && (
        <CardBody className="py-8 text-center text-sm text-white/50">No sessions found.</CardBody>
      )}

      {sessions && !isLoading && sessions.length > 0 && (
        <div className="divide-y divide-vault-border">
          {sessions.map((session) => {
            const state = sessionState(session);
            const Icon = STATE_ICON[state];
            return (
              <div key={session.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge tone={STATE_TONE[state]}>
                      <Icon className="h-3 w-3" aria-hidden="true" />
                      {STATE_LABEL[state]}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-white/40">
                    Started {formatDateTime(session.createdAt)} · Expires {formatDateTime(session.expiresAt)}
                  </p>
                </div>
                {state === "active" && (
                  <div className="flex flex-col items-end gap-1">
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      onClick={() => revokeMutation.mutate(session.id)}
                      isLoading={revokeMutation.isPending && revokeMutation.variables === session.id}
                    >
                      Sign out
                    </Button>
                    {revokeMutation.isError && revokeMutation.variables === session.id && (
                      <p role="alert" className="max-w-[12rem] text-right text-[11px] text-vault-down">
                        {revokeMutation.error instanceof ApiError ? revokeMutation.error.message : "Couldn't sign out this session."}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
