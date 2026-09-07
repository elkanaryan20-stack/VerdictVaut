import {
  AdminDeposit,
  AdminDepositListSchema,
  AdminWithdrawal,
  AdminWithdrawalListSchema,
  AdminWithdrawalSchema,
  AuditLogEntry,
  AuditLogEntryListSchema,
  StaleDeposit,
  StaleDepositListSchema,
  WithdrawalReconcileResult,
  WithdrawalReconcileResultSchema,
} from "@verdictvaut/shared-types";
import { apiFetch } from "../api-client";
import { parseOrThrow } from "../api-validation";

export async function fetchAdminDeposits(): Promise<AdminDeposit[]> {
  const data = await apiFetch<unknown>("/admin/deposits");
  return parseOrThrow(AdminDepositListSchema, data, "GET /admin/deposits");
}

export async function fetchStaleDeposits(): Promise<StaleDeposit[]> {
  const data = await apiFetch<unknown>("/admin/deposits/stale");
  return parseOrThrow(StaleDepositListSchema, data, "GET /admin/deposits/stale");
}

export interface ListAuditLogsOptions {
  resourceType?: string;
  actorId?: string;
}

export async function fetchAuditLogs(options: ListAuditLogsOptions = {}): Promise<AuditLogEntry[]> {
  const params = new URLSearchParams();
  if (options.resourceType) params.set("resourceType", options.resourceType);
  if (options.actorId) params.set("actorId", options.actorId);
  const query = params.toString();
  const data = await apiFetch<unknown>(`/admin/audit-logs${query ? `?${query}` : ""}`);
  return parseOrThrow(AuditLogEntryListSchema, data, "GET /admin/audit-logs");
}

/**
 * SUPER_ADMIN only (backend-enforced — see AdminController.reprocessDeposit).
 * Deliberately doesn't parse/trust the response body as the source of
 * truth for what happened — the caller refetches the deposits list right
 * after, so what renders is always the backend's own current state, not
 * this call's return value.
 */
export async function reprocessDeposit(depositId: string): Promise<void> {
  await apiFetch<unknown>(`/admin/deposits/${encodeURIComponent(depositId)}/reprocess`, { method: "POST" });
}

export async function fetchAdminWithdrawals(): Promise<AdminWithdrawal[]> {
  const data = await apiFetch<unknown>("/admin/withdrawals");
  return parseOrThrow(AdminWithdrawalListSchema, data, "GET /admin/withdrawals");
}

export async function fetchAdminWithdrawal(withdrawalId: string): Promise<AdminWithdrawal> {
  const data = await apiFetch<unknown>(`/admin/withdrawals/${encodeURIComponent(withdrawalId)}`);
  return parseOrThrow(AdminWithdrawalSchema, data, "GET /admin/withdrawals/:id");
}

/** SUPER_ADMIN only (backend-enforced). The caller refetches the withdrawal afterward — never trusts this call's own response as the source of truth for what happened. */
export async function approveWithdrawal(withdrawalId: string): Promise<void> {
  await apiFetch<unknown>(`/admin/withdrawals/${encodeURIComponent(withdrawalId)}/approve`, { method: "POST" });
}

export async function rejectWithdrawal(withdrawalId: string, reason: string): Promise<void> {
  await apiFetch<unknown>(`/admin/withdrawals/${encodeURIComponent(withdrawalId)}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/** Read + audit only — never mutates the withdrawal (see WithdrawalsService.reconcile's docblock). Returns the real comparison so a SUPER_ADMIN can decide what, if anything, to do next. */
export async function reconcileWithdrawal(withdrawalId: string): Promise<WithdrawalReconcileResult> {
  const data = await apiFetch<unknown>(`/admin/withdrawals/${encodeURIComponent(withdrawalId)}/reconcile`, { method: "POST" });
  return parseOrThrow(WithdrawalReconcileResultSchema, data, "POST /admin/withdrawals/:id/reconcile");
}
