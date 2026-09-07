"use client";

import type { CurrentUser } from "../../lib/auth/auth-context";
import { formatDateTime } from "../../lib/format";
import { Badge, BadgeTone } from "../ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/Card";

const STATUS_LABEL: Record<CurrentUser["status"], string> = {
  ACTIVE: "Active",
  PENDING_VERIFICATION: "Pending verification",
  SUSPENDED: "Suspended",
};

const STATUS_TONE: Record<CurrentUser["status"], BadgeTone> = {
  ACTIVE: "up",
  PENDING_VERIFICATION: "gold",
  SUSPENDED: "down",
};

const ROLE_LABEL: Record<CurrentUser["role"], string> = {
  USER: "User",
  RISK_OPS: "Risk operations",
  ADMIN: "Admin",
  SUPER_ADMIN: "Super admin",
};

/**
 * Every field here comes straight off the already-fetched /users/me
 * response (see AuthProvider) — no separate request, and nothing shown
 * that endpoint doesn't actually return (no password hash, no internal
 * security metadata, no custody/secret material).
 */
export function ProfileSummary({ user }: { user: CurrentUser }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-white/40">Email</p>
          <p className="mt-1 text-sm text-white">{user.email}</p>
        </div>
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-white/40">Account status</p>
            <Badge tone={STATUS_TONE[user.status]} className="mt-1.5">
              {STATUS_LABEL[user.status]}
            </Badge>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-white/40">Role</p>
            <Badge tone={user.role === "USER" ? "neutral" : "info"} className="mt-1.5">
              {ROLE_LABEL[user.role]}
            </Badge>
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-white/40">Member since</p>
          <p className="mt-1 text-sm text-white">{formatDateTime(user.createdAt)}</p>
        </div>
      </CardBody>
    </Card>
  );
}
