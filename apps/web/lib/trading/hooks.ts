"use client";

import type { MarketListFilterStatus, MarketStatus, OrderStatus } from "@verdictvaut/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cancelOrder,
  fetchMarket,
  fetchMarketCategories,
  fetchMarketResolutionStatus,
  fetchMarkets,
  fetchMyFills,
  fetchMyOrder,
  fetchMyOrders,
  fetchMyPositions,
  fetchMySettlement,
  fetchOrderBook,
  ListMyFillsOptions,
  ListMyOrdersOptions,
  placeOrder,
  PlaceOrderInput,
  retryMatching,
} from "./api";
import { isTerminalOrderStatus } from "./order-status";
import { useAssetNetworks, useBalances, walletKeys } from "../wallet/hooks";

// Conservative, bounded polling — never sub-second, and React Query's
// default refetchIntervalInBackground: false already stops all of these
// the moment the tab is hidden, with no extra code needed here.
const ORDER_BOOK_POLL_MS = 5_000;
const MY_ORDERS_POLL_MS = 10_000;
const ORDER_DETAIL_POLL_MS = 5_000;

export const tradingKeys = {
  markets: (status?: MarketListFilterStatus) => ["trading", "markets", status ?? "all"] as const,
  marketCategories: ["trading", "market-categories"] as const,
  market: (slug: string) => ["trading", "market", slug] as const,
  marketResolution: (marketId: string) => ["trading", "market-resolution", marketId] as const,
  mySettlement: (marketId: string) => ["trading", "my-settlement", marketId] as const,
  orderBook: (marketId: string, outcomeId: string) => ["trading", "order-book", marketId, outcomeId] as const,
  myOrders: (options: ListMyOrdersOptions) =>
    ["trading", "my-orders", options.page ?? 1, options.pageSize ?? 20, options.marketId ?? null, options.status ?? null] as const,
  myOrder: (orderId: string) => ["trading", "my-order", orderId] as const,
  myPositions: ["trading", "my-positions"] as const,
  myFills: (options: ListMyFillsOptions) => ["trading", "my-fills", options.page ?? 1, options.pageSize ?? 20, options.marketId ?? null] as const,
};

export function useMarkets(status?: MarketListFilterStatus) {
  return useQuery({
    queryKey: tradingKeys.markets(status),
    queryFn: () => fetchMarkets(status),
  });
}

export function useMarketCategories() {
  return useQuery({
    queryKey: tradingKeys.marketCategories,
    queryFn: fetchMarketCategories,
    // Reference data — changes rarely, no need to refetch on every focus.
    staleTime: 5 * 60_000,
  });
}

export function useMarket(slug: string | null) {
  return useQuery({
    queryKey: tradingKeys.market(slug ?? ""),
    queryFn: () => fetchMarket(slug!),
    enabled: Boolean(slug),
  });
}

export function useMarketResolutionStatus(marketId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: tradingKeys.marketResolution(marketId ?? ""),
    queryFn: () => fetchMarketResolutionStatus(marketId!),
    enabled: Boolean(marketId) && enabled,
  });
}

export function useMySettlement(marketId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: tradingKeys.mySettlement(marketId ?? ""),
    queryFn: () => fetchMySettlement(marketId!),
    enabled: Boolean(marketId) && enabled,
  });
}

/**
 * Only actively refreshes while the market is OPEN — a CLOSED/RESOLVING/
 * RESOLVED market's book can no longer change, so polling it would just
 * be wasted requests forever.
 */
export function useOrderBook(marketId: string | null, outcomeId: string | null, marketStatus: MarketStatus | undefined) {
  return useQuery({
    queryKey: tradingKeys.orderBook(marketId ?? "", outcomeId ?? ""),
    queryFn: () => fetchOrderBook(marketId!, outcomeId!),
    enabled: Boolean(marketId && outcomeId),
    refetchInterval: marketStatus === "OPEN" ? ORDER_BOOK_POLL_MS : false,
  });
}

export function useMyOrders(options: ListMyOrdersOptions & { enabled?: boolean }) {
  const { enabled = true, ...fetchOptions } = options;
  return useQuery({
    queryKey: tradingKeys.myOrders(fetchOptions),
    queryFn: () => fetchMyOrders(fetchOptions),
    enabled,
    placeholderData: (previous) => previous,
    refetchInterval: (query) => {
      const items = query.state.data?.items;
      if (!items || items.length === 0) return false;
      const hasUnresolved = items.some((order) => !isTerminalOrderStatus(order.status));
      return hasUnresolved ? MY_ORDERS_POLL_MS : false;
    },
  });
}

export function useMyOrder(orderId: string | null) {
  return useQuery({
    queryKey: tradingKeys.myOrder(orderId ?? ""),
    queryFn: () => fetchMyOrder(orderId!),
    enabled: Boolean(orderId),
    refetchInterval: (query) => (query.state.data && !isTerminalOrderStatus(query.state.data.status) ? ORDER_DETAIL_POLL_MS : false),
  });
}

/**
 * The order ticket needs "how much settlement currency can I spend on a
 * BUY" — the backend doesn't expose a dedicated "which asset is the
 * settlement currency" endpoint, but GET /wallet/asset-networks already
 * carries `asset.isSettlementCurrency` (see Phase 6A's DepositFlow, which
 * consumes the same endpoint), so this derives it from data already being
 * fetched rather than adding a new backend call.
 */
export function useSettlementCurrencyBalance(enabled = true) {
  const balances = useBalances(enabled);
  const assetNetworks = useAssetNetworks(enabled);
  const settlementSymbol = assetNetworks.data?.find((an) => an.asset.isSettlementCurrency)?.asset.symbol;
  const balance = settlementSymbol ? balances.data?.find((b) => b.symbol === settlementSymbol) : undefined;
  return {
    isLoading: balances.isLoading || assetNetworks.isLoading,
    isError: balances.isError || assetNetworks.isError,
    refetch: () => {
      balances.refetch();
      assetNetworks.refetch();
    },
    settlementSymbol,
    balance,
  };
}

export function useMyPositions(enabled = true) {
  return useQuery({
    queryKey: tradingKeys.myPositions,
    queryFn: fetchMyPositions,
    enabled,
  });
}

export function useMyFills(options: ListMyFillsOptions) {
  return useQuery({
    queryKey: tradingKeys.myFills(options),
    queryFn: () => fetchMyFills(options),
    placeholderData: (previous) => previous,
  });
}

/**
 * Placing/cancelling/retrying an order changes reserved cash or
 * position quantity (via the backend's own reservation logic) — so the
 * wallet's balances, this market's book, and every "my ___" trading list
 * are all invalidated together. None of these values are computed
 * client-side; invalidating just makes the next read hit the backend
 * again instead of showing stale numbers.
 */
function invalidateAfterTradingAction(queryClient: ReturnType<typeof useQueryClient>, marketId?: string, outcomeId?: string) {
  queryClient.invalidateQueries({ queryKey: walletKeys.balances });
  queryClient.invalidateQueries({ queryKey: ["trading", "my-orders"] });
  queryClient.invalidateQueries({ queryKey: ["trading", "my-order"] });
  queryClient.invalidateQueries({ queryKey: tradingKeys.myPositions });
  if (marketId && outcomeId) {
    queryClient.invalidateQueries({ queryKey: tradingKeys.orderBook(marketId, outcomeId) });
  }
}

export function usePlaceOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PlaceOrderInput) => placeOrder(input),
    onSuccess: (_result, variables) => {
      invalidateAfterTradingAction(queryClient, variables.marketId, variables.outcomeId);
    },
  });
}

export function useCancelOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => cancelOrder(orderId),
    onSuccess: (order) => {
      invalidateAfterTradingAction(queryClient, order.marketId, order.outcomeId);
    },
  });
}

export function useRetryMatching() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => retryMatching(orderId),
    onSuccess: (result) => {
      // OrderPlacementResult doesn't carry marketId/outcomeId, so the
      // order-book cache for this order's market can't be targeted
      // directly here — the book's own OPEN-market polling (see
      // useOrderBook) picks up the change on its next tick regardless.
      invalidateAfterTradingAction(queryClient);
      queryClient.invalidateQueries({ queryKey: tradingKeys.myOrder(result.orderId) });
    },
  });
}
