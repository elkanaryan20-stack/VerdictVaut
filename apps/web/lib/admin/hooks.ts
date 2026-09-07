"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  approveWithdrawal,
  fetchAdminDeposits,
  fetchAdminWithdrawal,
  fetchAdminWithdrawals,
  fetchAuditLogs,
  fetchStaleDeposits,
  ListAuditLogsOptions,
  reconcileWithdrawal,
  rejectWithdrawal,
  reprocessDeposit,
} from "./api";
import { fetchMarketResolutionStatus, fetchMarkets } from "../trading/api";

export const adminKeys = {
  deposits: ["admin", "deposits"] as const,
  staleDeposits: ["admin", "deposits", "stale"] as const,
  auditLogs: (options: ListAuditLogsOptions) => ["admin", "audit-logs", options.resourceType ?? null, options.actorId ?? null] as const,
  resolvingMarkets: ["admin", "resolving-markets"] as const,
  withdrawals: ["admin", "withdrawals"] as const,
  withdrawal: (id: string) => ["admin", "withdrawal", id] as const,
};

export function useAdminDeposits() {
  return useQuery({
    queryKey: adminKeys.deposits,
    queryFn: fetchAdminDeposits,
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
      queryClient.invalidateQueries({ queryKey: adminKeys.deposits });
      queryClient.invalidateQueries({ queryKey: adminKeys.staleDeposits });
    },
  });
}

export function useAdminWithdrawals() {
  return useQuery({
    queryKey: adminKeys.withdrawals,
    queryFn: fetchAdminWithdrawals,
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
  queryClient.invalidateQueries({ queryKey: adminKeys.withdrawals });
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
