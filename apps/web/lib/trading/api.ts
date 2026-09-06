import {
  Market,
  MarketCategory,
  MarketCategorySchema,
  MarketListFilterStatus,
  MarketListSchema,
  MarketResolutionStatus,
  MarketResolutionStatusSchema,
  MarketSchema,
  MySettlementsSchema,
  Order,
  OrderBookView,
  OrderBookViewSchema,
  OrderPlacementResult,
  OrderPlacementResultSchema,
  OrderSchema,
  OrderStatus,
  PaginatedFills,
  PaginatedFillsSchema,
  PaginatedOrders,
  PaginatedOrdersSchema,
  Position,
  PositionListSchema,
  PositionSettlement,
} from "@verdictvaut/shared-types";
import { z } from "zod";
import { apiFetch } from "../api-client";
import { parseOrThrow } from "../api-validation";

export async function fetchMarkets(status?: MarketListFilterStatus): Promise<Market[]> {
  const params = status ? `?status=${encodeURIComponent(status)}` : "";
  const data = await apiFetch<unknown>(`/markets${params}`);
  return parseOrThrow(MarketListSchema, data, "GET /markets");
}

export async function fetchMarketCategories(): Promise<MarketCategory[]> {
  const data = await apiFetch<unknown>("/markets/categories");
  return parseOrThrow(z.array(MarketCategorySchema), data, "GET /markets/categories");
}

export async function fetchMarket(slug: string): Promise<Market> {
  const data = await apiFetch<unknown>(`/markets/${encodeURIComponent(slug)}`);
  return parseOrThrow(MarketSchema, data, "GET /markets/:slug");
}

export async function fetchMarketResolutionStatus(marketId: string): Promise<MarketResolutionStatus> {
  const data = await apiFetch<unknown>(`/markets/${encodeURIComponent(marketId)}/resolution`);
  return parseOrThrow(MarketResolutionStatusSchema, data, "GET /markets/:id/resolution");
}

export async function fetchMySettlement(marketId: string): Promise<PositionSettlement[]> {
  const data = await apiFetch<unknown>(`/markets/${encodeURIComponent(marketId)}/settlement/mine`);
  return parseOrThrow(MySettlementsSchema, data, "GET /markets/:id/settlement/mine");
}

export async function fetchOrderBook(marketId: string, outcomeId: string): Promise<OrderBookView> {
  const data = await apiFetch<unknown>(`/trading/markets/${encodeURIComponent(marketId)}/outcomes/${encodeURIComponent(outcomeId)}/book`);
  return parseOrThrow(OrderBookViewSchema, data, "GET /trading/markets/:marketId/outcomes/:outcomeId/book");
}

export interface ListMyOrdersOptions {
  page?: number;
  pageSize?: number;
  marketId?: string;
  status?: OrderStatus;
}

export async function fetchMyOrders(options: ListMyOrdersOptions = {}): Promise<PaginatedOrders> {
  const params = new URLSearchParams();
  if (options.page) params.set("page", String(options.page));
  if (options.pageSize) params.set("pageSize", String(options.pageSize));
  if (options.marketId) params.set("marketId", options.marketId);
  if (options.status) params.set("status", options.status);
  const query = params.toString();
  const data = await apiFetch<unknown>(`/trading/orders${query ? `?${query}` : ""}`);
  return parseOrThrow(PaginatedOrdersSchema, data, "GET /trading/orders");
}

export async function fetchMyOrder(orderId: string): Promise<Order> {
  const data = await apiFetch<unknown>(`/trading/orders/${encodeURIComponent(orderId)}`);
  return parseOrThrow(OrderSchema, data, "GET /trading/orders/:id");
}

export async function fetchMyPositions(): Promise<Position[]> {
  const data = await apiFetch<unknown>("/trading/positions");
  return parseOrThrow(PositionListSchema, data, "GET /trading/positions");
}

export interface ListMyFillsOptions {
  page?: number;
  pageSize?: number;
  marketId?: string;
}

export async function fetchMyFills(options: ListMyFillsOptions = {}): Promise<PaginatedFills> {
  const params = new URLSearchParams();
  if (options.page) params.set("page", String(options.page));
  if (options.pageSize) params.set("pageSize", String(options.pageSize));
  if (options.marketId) params.set("marketId", options.marketId);
  const query = params.toString();
  const data = await apiFetch<unknown>(`/trading/fills${query ? `?${query}` : ""}`);
  return parseOrThrow(PaginatedFillsSchema, data, "GET /trading/fills");
}

export interface PlaceOrderInput {
  marketId: string;
  outcomeId: string;
  side: "BUY" | "SELL";
  /** Backend-supported order types only — MARKET exists in the DB enum but is rejected server-side, so the ticket never offers it. */
  type: "LIMIT";
  price: string;
  quantity: string;
  clientOrderId: string;
}

export async function placeOrder(input: PlaceOrderInput): Promise<OrderPlacementResult> {
  const data = await apiFetch<unknown>("/trading/orders", { method: "POST", body: JSON.stringify(input) });
  return parseOrThrow(OrderPlacementResultSchema, data, "POST /trading/orders");
}

export async function retryMatching(orderId: string): Promise<OrderPlacementResult> {
  const data = await apiFetch<unknown>(`/trading/orders/${encodeURIComponent(orderId)}/retry-matching`, { method: "POST" });
  return parseOrThrow(OrderPlacementResultSchema, data, "POST /trading/orders/:id/retry-matching");
}

export async function cancelOrder(orderId: string): Promise<Order> {
  const data = await apiFetch<unknown>(`/trading/orders/${encodeURIComponent(orderId)}/cancel`, { method: "POST" });
  return parseOrThrow(OrderSchema, data, "POST /trading/orders/:id/cancel");
}
