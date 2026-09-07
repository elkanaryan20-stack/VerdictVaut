import { z } from "zod";
import { AssetNetworkRefSchema, DepositSchema, WithdrawalSchema } from "./wallet";

/**
 * Shapes mirroring the backend's actual API responses for the Phase 7
 * restricted-operations (admin) views (see apps/api/src/admin/**). These
 * are read/response schemas for ADMIN/SUPER_ADMIN-only endpoints — the
 * backend's own RolesGuard remains the real authorization boundary; this
 * is only what the frontend can assume it receives back once authorized.
 */

/** GET /admin/deposits and GET /admin/deposits/:id — always carries the depositor and the asset/network, unlike the user-facing deposit views. */
export const AdminDepositSchema = DepositSchema.extend({
  user: z.object({ id: z.string(), email: z.string() }),
  assetNetwork: AssetNetworkRefSchema,
});
export type AdminDeposit = z.infer<typeof AdminDepositSchema>;
export const AdminDepositListSchema = z.array(AdminDepositSchema);

/** The subset of GET /admin/deposits/stale's raw Deposit rows the stale-deposits view actually renders (no user/assetNetwork join on that query). */
export const StaleDepositSchema = z.object({
  id: z.string(),
  userId: z.string(),
  assetNetworkId: z.string(),
  txHash: z.string(),
  amount: z.string(),
  status: z.string(),
  detectedAt: z.string(),
  lastCheckedAt: z.string().nullable(),
});
export type StaleDeposit = z.infer<typeof StaleDepositSchema>;
export const StaleDepositListSchema = z.array(StaleDepositSchema);

/** GET /admin/withdrawals and GET /admin/withdrawals/:id — always carries the withdrawing user and the asset/network, unlike the user-facing withdrawal views. */
export const AdminWithdrawalSchema = WithdrawalSchema.extend({
  user: z.object({ id: z.string(), email: z.string() }),
  assetNetwork: AssetNetworkRefSchema,
});
export type AdminWithdrawal = z.infer<typeof AdminWithdrawalSchema>;
export const AdminWithdrawalListSchema = z.array(AdminWithdrawalSchema);

export const AUDIT_ACTOR_TYPES = ["USER", "ADMIN", "SYSTEM"] as const;
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

/** GET /admin/audit-logs — the platform's append-only administrative/financial-control trail (see AuditLogService). */
export const AuditLogEntrySchema = z.object({
  id: z.string(),
  actorId: z.string().nullable(),
  actorType: AuditActorTypeSchema,
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;
export const AuditLogEntryListSchema = z.array(AuditLogEntrySchema);
