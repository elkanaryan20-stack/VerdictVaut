"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  assignDepositAddress,
  cancelWithdrawal,
  fetchAssetNetworks,
  fetchBalances,
  fetchDeposit,
  fetchDeposits,
  fetchMyDepositAddresses,
  fetchWithdrawal,
  fetchWithdrawals,
  RequestWithdrawalInput,
  requestWithdrawal,
} from "./api";
import { isTerminalDepositStatus } from "./deposit-status";
import { isTerminalWithdrawalStatus } from "./withdrawal-status";

// Conservative, bounded polling intervals — never sub-second, and only
// ever active while there is something to actually wait on.
const DEPOSIT_DETAIL_POLL_MS = 10_000;
const DEPOSIT_LIST_POLL_MS = 20_000;
const WITHDRAWAL_DETAIL_POLL_MS = 10_000;
const WITHDRAWAL_LIST_POLL_MS = 20_000;

export const walletKeys = {
  balances: ["wallet", "balances"] as const,
  assetNetworks: ["wallet", "asset-networks"] as const,
  depositAddresses: ["wallet", "deposit-addresses"] as const,
  deposits: (page: number, pageSize: number) => ["wallet", "deposits", page, pageSize] as const,
  deposit: (id: string) => ["wallet", "deposit", id] as const,
  withdrawals: ["wallet", "withdrawals"] as const,
  withdrawal: (id: string) => ["wallet", "withdrawal", id] as const,
};

/**
 * `enabled` defaults to true (every existing /wallet caller runs inside
 * AuthGuard, so it's always meant to fire there) — Phase 6B's order
 * ticket is the first caller that can render on a PUBLIC page for an
 * anonymous visitor, where firing an authenticated request at all would
 * be a wasted, guaranteed-401 call.
 */
export function useBalances(enabled = true) {
  return useQuery({
    queryKey: walletKeys.balances,
    queryFn: fetchBalances,
    enabled,
  });
}

export function useAssetNetworks(enabled = true) {
  return useQuery({
    queryKey: walletKeys.assetNetworks,
    queryFn: fetchAssetNetworks,
    enabled,
    // Reference/configuration data — changes rarely, no need to refetch on every focus.
    staleTime: 5 * 60_000,
  });
}

export function useMyDepositAddresses() {
  return useQuery({
    queryKey: walletKeys.depositAddresses,
    queryFn: fetchMyDepositAddresses,
  });
}

/**
 * Deliberately a QUERY, not a mutation, even though it hits a POST
 * endpoint — `getOrAssign` on the backend is idempotent (same user +
 * asset + network always returns the same address), so treating this as
 * an idempotent read keyed by (assetSymbol, networkCode) is both
 * semantically honest and gets correctness for free: switching networks
 * changes the query key, so React Query tracks each selection's
 * loading/success/error state independently. A `useMutation` sharing one
 * hook instance across repeated `.mutate()` calls has no such guarantee
 * — if a user switches networks quickly, an earlier (now-stale) request
 * resolving AFTER a later one could overwrite the hook's shared `.data`
 * with the WRONG network's address while the UI still shows the new
 * network as selected. A query keyed per-selection can't do that: a
 * stale in-flight request for an abandoned key updates only that key's
 * cache entry, never the one currently being rendered.
 */
export function useDepositAddress(assetSymbol: string | null, networkCode: string | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: ["wallet", "assign-deposit-address", assetSymbol, networkCode] as const,
    queryFn: async () => {
      const assignment = await assignDepositAddress(assetSymbol!, networkCode!);
      queryClient.invalidateQueries({ queryKey: walletKeys.depositAddresses });
      return assignment;
    },
    enabled: Boolean(assetSymbol && networkCode),
    // The assignment never changes for a given (user, asset, network) —
    // no need to ever refetch it once we have it for this selection.
    staleTime: Infinity,
  });
}

/**
 * A deposit reaching CREDITED is exactly the moment the user's real
 * balance changed — anyone polling a pending deposit (the list or the
 * detail view) should see their balance reflect that without having to
 * navigate away and back. React Query v5 has no `onSuccess` callback on
 * `useQuery` any more, so this watches the resolved data itself and
 * invalidates the balances query the instant a previously-unseen
 * CREDITED id shows up — never on every poll, only on the actual
 * transition.
 */
function useInvalidateBalancesOnNewlyCredited(creditedIds: string[]) {
  const queryClient = useQueryClient();
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    const hasNew = creditedIds.some((id) => !seen.current.has(id));
    if (hasNew) {
      queryClient.invalidateQueries({ queryKey: walletKeys.balances });
    }
    for (const id of creditedIds) seen.current.add(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creditedIds.join(","), queryClient]);
}

export function useDeposits(page: number, pageSize: number) {
  const query = useQuery({
    queryKey: walletKeys.deposits(page, pageSize),
    queryFn: () => fetchDeposits(page, pageSize),
    // Keep showing the previous page's rows while the next page loads,
    // instead of flashing a skeleton on every pagination click.
    placeholderData: (previous) => previous,
    refetchInterval: (query) => {
      const items = query.state.data?.items;
      if (!items || items.length === 0) return false;
      const hasUnresolved = items.some((deposit) => !isTerminalDepositStatus(deposit.status));
      return hasUnresolved ? DEPOSIT_LIST_POLL_MS : false;
    },
  });

  const creditedIds = (query.data?.items ?? []).filter((d) => d.status === "CREDITED").map((d) => d.id);
  useInvalidateBalancesOnNewlyCredited(creditedIds);

  return query;
}

export function useDeposit(depositId: string | null) {
  const query = useQuery({
    queryKey: walletKeys.deposit(depositId ?? ""),
    queryFn: () => fetchDeposit(depositId!),
    enabled: Boolean(depositId),
    refetchInterval: (query) => (query.state.data && !isTerminalDepositStatus(query.state.data.status) ? DEPOSIT_DETAIL_POLL_MS : false),
  });

  const creditedIds = query.data?.status === "CREDITED" ? [query.data.id] : [];
  useInvalidateBalancesOnNewlyCredited(creditedIds);

  return query;
}

/**
 * A flat list — GET /wallet/withdrawals is not paginated on the backend
 * (naturally bounded per user), so this never invents client-side
 * pagination the API doesn't actually provide.
 */
export function useWithdrawals() {
  const query = useQuery({
    queryKey: walletKeys.withdrawals,
    queryFn: fetchWithdrawals,
    refetchInterval: (query) => {
      const items = query.state.data;
      if (!items || items.length === 0) return false;
      const hasUnresolved = items.some((w) => !isTerminalWithdrawalStatus(w.status));
      return hasUnresolved ? WITHDRAWAL_LIST_POLL_MS : false;
    },
  });

  // A withdrawal reaching CREDITED is exactly the moment the user's real
  // balance changed (the reservation is captured and the ledger posts
  // the real debit only at that point — see WithdrawalsService
  // .recordConfirmation) — same reasoning as deposits reaching CREDITED.
  const creditedIds = (query.data ?? []).filter((w) => w.status === "CREDITED").map((w) => w.id);
  useInvalidateBalancesOnNewlyCredited(creditedIds);

  return query;
}

export function useWithdrawal(withdrawalId: string | null) {
  const query = useQuery({
    queryKey: walletKeys.withdrawal(withdrawalId ?? ""),
    queryFn: () => fetchWithdrawal(withdrawalId!),
    enabled: Boolean(withdrawalId),
    refetchInterval: (query) => (query.state.data && !isTerminalWithdrawalStatus(query.state.data.status) ? WITHDRAWAL_DETAIL_POLL_MS : false),
  });

  const creditedIds = query.data?.status === "CREDITED" ? [query.data.id] : [];
  useInvalidateBalancesOnNewlyCredited(creditedIds);

  return query;
}

/**
 * Placing a withdrawal changes reserved balance (via the backend's own
 * reservation logic) — invalidating balances + the withdrawals list
 * makes the next read hit the backend again instead of showing a stale
 * available-balance figure. Never computed client-side.
 */
export function useRequestWithdrawal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RequestWithdrawalInput) => requestWithdrawal(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: walletKeys.balances });
      queryClient.invalidateQueries({ queryKey: walletKeys.withdrawals });
    },
  });
}

export function useCancelWithdrawal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (withdrawalId: string) => cancelWithdrawal(withdrawalId),
    onSuccess: (_result, withdrawalId) => {
      queryClient.invalidateQueries({ queryKey: walletKeys.balances });
      queryClient.invalidateQueries({ queryKey: walletKeys.withdrawals });
      queryClient.invalidateQueries({ queryKey: walletKeys.withdrawal(withdrawalId) });
    },
  });
}
