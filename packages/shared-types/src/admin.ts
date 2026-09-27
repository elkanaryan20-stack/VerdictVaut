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

/**
 * Phase 36 — GET /admin/jobs (Phase 35): persisted state of worker
 * background jobs (scheduled reconciliation leases/outcomes and the
 * withdrawal watcher's per-pass heartbeat). Read-only operator visibility.
 */
export const ScheduledJobStateSchema = z.object({
  jobKey: z.string(),
  lockedAt: z.string().nullable(),
  lockedBy: z.string().nullable(),
  lastStartedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastSummary: z.string().nullable(),
  updatedAt: z.string(),
});
export type ScheduledJobState = z.infer<typeof ScheduledJobStateSchema>;
export const ScheduledJobStateListSchema = z.array(ScheduledJobStateSchema);

export const DISCREPANCY_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED", "FALSE_POSITIVE"] as const;
export const DiscrepancyStatusSchema = z.enum(DISCREPANCY_STATUSES);
export type DiscrepancyStatus = z.infer<typeof DiscrepancyStatusSchema>;

/**
 * Phase 36 — the fields of GET /admin/reconciliation/discrepancies the
 * operations view renders. expectedState/observedState (raw chain/ledger
 * evidence JSON) are deliberately not part of this summary.
 */
export const ReconciliationDiscrepancySummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: z.string(),
  status: DiscrepancyStatusSchema,
  chainIdentity: z.string(),
  assetNetworkId: z.string().nullable(),
  marketId: z.string().nullable(),
  internalEntityType: z.string().nullable(),
  internalEntityId: z.string().nullable(),
  createdAt: z.string(),
});
export type ReconciliationDiscrepancySummary = z.infer<typeof ReconciliationDiscrepancySummarySchema>;
export const ReconciliationDiscrepancySummaryListSchema = z.array(ReconciliationDiscrepancySummarySchema);
