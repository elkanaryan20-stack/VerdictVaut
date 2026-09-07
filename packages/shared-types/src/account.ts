import { z } from "zod";

/**
 * Shapes mirroring the backend's actual API responses for the account/
 * security domain added in Phase 7 (see apps/api/src/auth/**,
 * apps/api/src/users/**). Read/response schemas only — the backend
 * remains the single source of truth for what it accepts.
 */

/**
 * GET /auth/sessions — one row per issued refresh token for the calling
 * user. There is no device/IP/user-agent column on the backend's
 * RefreshToken table, so none is invented here — `isActive` is derived
 * client-side from `revokedAt`/`expiresAt`, never a separate backend flag.
 */
export const SessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;
export const SessionListSchema = z.array(SessionSchema);

/**
 * GET /users/me/security-events — the calling user's own audit trail
 * (login, logout, register, password change, session revoke). Backed by
 * the same AuditLog table the admin audit-log view reads, filtered to
 * rows this user generated as the actor — never another user's activity.
 */
export const SecurityEventSchema = z.object({
  id: z.string(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type SecurityEvent = z.infer<typeof SecurityEventSchema>;
export const SecurityEventListSchema = z.array(SecurityEventSchema);
