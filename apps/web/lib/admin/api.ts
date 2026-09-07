import { AdminDeposit, AdminDepositListSchema, AuditLogEntry, AuditLogEntryListSchema, StaleDeposit, StaleDepositListSchema } from "@verdictvaut/shared-types";
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
