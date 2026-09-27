"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approveWithdrawal,
  fetchAdminDeposits,
  fetchAdminWithdrawal,
  fetchAdminWithdrawals,
  fetchAuditLogs,
  fetchOpenDiscrepancies,
  fetchScheduledJobs,
  fetchStaleDeposits,
  fetchStaleWithdrawals,
  ListAuditLogsOptions,
  reconcileWithdrawal,
  rejectWithdrawal,
  reprocessDeposit,
} from "./api";
import { fetchMarketResolutionStatus, fetchMarkets } from "../trading/api";

export const adminKeys = {
  deposits: (page: number, pageSize: number) => ["admin", "deposits", page, pageSize] as const,
  staleDeposits: ["admin", "deposits", "stale"] as const,
  auditLogs: (options: ListAuditLogsOptions) => ["admin", "audit-logs", options.resourceType ?? null, options.actorId ?? null] as const,
  resolvingMarkets: ["admin", "resolving-markets"] as const,
  withdrawals: (page: number, pageSize: number) => ["admin", "withdrawals", page, pageSize] as const,
  withdrawal: (id: string) => ["admin", "withdrawal", id] as const,
};

/**
 * Phase 30 — page/pageSize are now real, paginated params (previously
 * this always fetched page 1 only, and the table additionally sliced
 * to 50 rows client-side — once a platform accumulates more than 100
 * deposits total, everything past that was permanently unreachable
 * through this UI). placeholderData keeps showing the previous page's
 * rows while the next page loads, matching useDeposits' own pattern.
 */
export function useAdminDeposits(page: number, pageSize: number) {
  return useQuery({
    queryKey: adminKeys.deposits(page, pageSize),
    queryFn: () => fetchAdminDeposits(page, pageSize),
    placeholderData: (previous) => previous,
  });
}

export function useStaleDeposits() {
  return useQuery({
    queryKey: adminKeys.staleDeposits,
    queryFn: fetchStaleDeposits,
  });
}

export function useAuditLogs(options: ListAuditLogsOptions = {}) {
  return useQuery({
    queryKey: adminKeys.auditLogs(options),
    queryFn: () => fetchAuditLogs(options),
  });
}

export function useReprocessDeposit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (depositId: string) => reprocessDeposit(depositId),
    onSuccess: () => {
      // Prefix match — invalidates every page's cached query at once
      // (adminKeys.deposits is now page/pageSize-keyed; React Query
      // matches queryKey by prefix by default, so the bare ["admin",
      // "deposits"] prefix below still reaches all of them).
      queryClient.invalidateQueries({ queryKey: ["admin", "deposits"] });
      queryClient.invalidateQueries({ queryKey: adminKeys.staleDeposits });
    },
  });
}

export function useAdminWithdrawals(page: number, pageSize: number) {
  return useQuery({
    queryKey: adminKeys.withdrawals(page, pageSize),
    queryFn: () => fetchAdminWithdrawals(page, pageSize),
    placeholderData: (previous) => previous,
  });
}

export function useAdminWithdrawal(withdrawalId: string | null) {
  return useQuery({
    queryKey: adminKeys.withdrawal(withdrawalId ?? ""),
    queryFn: () => fetchAdminWithdrawal(withdrawalId!),
    enabled: Boolean(withdrawalId),
  });
}

function invalidateAfterWithdrawalMutation(queryClient: ReturnType<typeof useQueryClient>, withdrawalId: string) {
  // Prefix match — see useReprocessDeposit's identical comment above.
  queryClient.invalidateQueries({ queryKey: ["admin", "withdrawals"] });
  queryClient.invalidateQueries({ queryKey: adminKeys.withdrawal(withdrawalId) });
}

export function useApproveWithdrawal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (withdrawalId: string) => approveWithdrawal(withdrawalId),
    onSuccess: (_result, withdrawalId) => invalidateAfterWithdrawalMutation(queryClient, withdrawalId),
  });
}

export function useRejectWithdrawal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ withdrawalId, reason }: { withdrawalId: string; reason: string }) => rejectWithdrawal(withdrawalId, reason),
    onSuccess: (_result, { withdrawalId }) => invalidateAfterWithdrawalMutation(queryClient, withdrawalId),
  });
}

export function useReconcileWithdrawal() {
  return useMutation({
    mutationFn: (withdrawalId: string) => reconcileWithdrawal(withdrawalId),
  });
}

/**
 * "Markets needing attention" — every RESOLVING market (resolved, but
 * settlement hasn't finished paying out every position yet) together
 * with its settlement progress. Built entirely from the PUBLIC market
 * endpoints Phase 6B already uses (GET /markets?status=RESOLVING, GET
 * /markets/:id/resolution) — no admin-only backend call exists or is
 * needed for this; the "restricted" part of this view is only that it's
 * surfaced on the admin ops page, not that the data itself is privileged.
 * Bounded by however many markets are currently mid-settlement (normally
 * a handful), the same N+1-is-fine reasoning as useMySettlements.
 */
export function useMarketsNeedingAttention() {
  const marketsQuery = useQuery({
    queryKey: adminKeys.resolvingMarkets,
    queryFn: () => fetchMarkets("RESOLVING"),
  });
  const markets = marketsQuery.data ?? [];

  const resolutionQueries = useQueries({
    queries: markets.map((market) => ({
      queryKey: ["trading", "market-resolution", market.id] as const,
      queryFn: () => fetchMarketResolutionStatus(market.id),
    })),
  });

  const isLoading = marketsQuery.isLoading || resolutionQueries.some((q) => q.isLoading);
  const isError = marketsQuery.isError;
  const hasPartialError = resolutionQueries.some((q) => q.isError);

  const items = markets.map((market, i) => ({ market, resolution: resolutionQueries[i]?.data ?? null }));

  function refetch() {
    marketsQuery.refetch();
    resolutionQueries.forEach((q) => q.refetch());
  }

  return { items, isLoading, isError, hasPartialError, refetch };
}

// Phase 36 — read-only operational views over Phase 35 endpoints. Polled
// gently (60s) since they describe worker/reconciliation state that
// changes on the order of minutes; no mutation lives here.
const OPERATIONS_REFETCH_MS = 60_000;

export function useStaleWithdrawals() {
  return useQuery({ queryKey: ["admin", "withdrawals", "stale"], queryFn: fetchStaleWithdrawals, refetchInterval: OPERATIONS_REFETCH_MS });
}

export function useScheduledJobs() {
  return useQuery({ queryKey: ["admin", "jobs"], queryFn: fetchScheduledJobs, refetchInterval: OPERATIONS_REFETCH_MS });
}

export function useOpenDiscrepancies() {
  return useQuery({ queryKey: ["admin", "discrepancies", "OPEN"], queryFn: fetchOpenDiscrepancies, refetchInterval: OPERATIONS_REFETCH_MS });
}
