import type { MarketStatus, OrderStatus } from "@verdictvaut/shared-types";

/** CANCELLED/EXPIRED/REJECTED/FILLED never transition further — safe to stop polling once here. */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return status === "FILLED" || status === "CANCELLED" || status === "EXPIRED" || status === "REJECTED";
}

export function isCancellableOrderStatus(status: OrderStatus): boolean {
  return status === "OPEN" || status === "PARTIALLY_FILLED";
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  OPEN: "Open",
  PARTIALLY_FILLED: "Partially filled",
  FILLED: "Filled",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  REJECTED: "Rejected",
};

export const ORDER_STATUS_DESCRIPTION: Record<OrderStatus, string> = {
  OPEN: "Resting on the order book, unfilled.",
  PARTIALLY_FILLED: "Some quantity has executed; the remainder is still resting.",
  FILLED: "Fully executed.",
  CANCELLED: "Cancelled before it could fully execute.",
  EXPIRED: "Terminated automatically, e.g. because its market closed.",
  REJECTED: "Rejected before it could be placed.",
};

/**
 * The only four states a market is ever offered as a public filter for
 * (see MarketsController — DRAFT is never listed, PAUSED/CANCELLED are
 * unreachable states today).
 */
export const MARKET_STATUS_LABEL: Record<MarketStatus, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  PAUSED: "Paused",
  CLOSED: "Closed",
  RESOLVING: "Resolving",
  RESOLVED: "Resolved",
  CANCELLED: "Cancelled",
};

export function isMarketTradable(status: MarketStatus): boolean {
  return status === "OPEN";
}
