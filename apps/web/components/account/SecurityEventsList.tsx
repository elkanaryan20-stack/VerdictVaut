"use client";

import { KeyRound, LogIn, LogOut, ShieldOff, UserPlus } from "lucide-react";
import { useSecurityEvents } from "../../lib/account/hooks";
import { formatDateTime } from "../../lib/format";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";
import { Skeleton } from "../ui/Skeleton";

const ACTION_LABEL: Record<string, string> = {
  "user.login": "Signed in",
  "user.logout": "Signed out",
  "user.register": "Account created",
  "user.change_password": "Password changed",
  "user.session_revoke": "Session signed out remotely",
};

const ACTION_ICON: Record<string, typeof LogIn> = {
  "user.login": LogIn,
  "user.logout": LogOut,
  "user.register": UserPlus,
  "user.change_password": KeyRound,
  "user.session_revoke": ShieldOff,
};

/**
 * The user's own security/account audit trail — GET
 * /users/me/security-events, scoped server-side to rows this exact user
 * generated as the actor (see UsersController). Only events this app
 * actually records appear here (login/logout/register/password
 * change/session revoke) — an unrecognized `action` still renders,
 * verbatim, rather than being silently dropped, so nothing real is ever
 * hidden even if a future backend action isn't in the label map yet.
 */
export function SecurityEventsList() {
  const { data: events, isLoading, isError, refetch } = useSecurityEvents();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Security &amp; account events</CardTitle>
      </CardHeader>

      {isLoading && (
        <CardBody className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardBody>
      )}

      {isError && !isLoading && (
        <CardBody className="flex flex-col items-start gap-3 text-sm text-white/60">
          <p>Couldn&apos;t load your security events.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs font-medium text-white hover:bg-white/5"
          >
            Retry
          </button>
        </CardBody>
      )}

      {events && !isLoading && events.length === 0 && (
        <CardBody className="py-8 text-center text-sm text-white/50">No security events recorded yet.</CardBody>
      )}

      {events && !isLoading && events.length > 0 && (
        <div className="divide-y divide-vault-border">
          {events.map((event) => {
            const Icon = ACTION_ICON[event.action] ?? KeyRound;
            return (
              <div key={event.id} className="flex items-center gap-3 px-5 py-3">
                <Icon className="h-4 w-4 shrink-0 text-white/40" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white">{ACTION_LABEL[event.action] ?? event.action}</p>
                  <p className="text-xs text-white/40">{formatDateTime(event.createdAt)}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
