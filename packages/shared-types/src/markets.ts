import { z } from "zod";
import { OrderSideSchema, OrderTypeSchema } from "./trading";

/**
 * Shapes mirroring the backend's actual API responses for the markets/
 * trading domain (see apps/api/src/{markets,trading,settlement}/**). These
 * are read/response schemas, not request-validation duplicates of the
 * backend's own DTOs — the backend remains the single source of truth for
 * what it accepts and computes; this is what the frontend can safely
 * assume it receives back.
 */

/**
 * Full backend lifecycle enum (DRAFT -> OPEN -> CLOSED -> RESOLVING ->
 * RESOLVED, with PAUSED/CANCELLED reachable in the schema but not wired to
 * any code path yet — see the cross-phase architecture audit). The
 * frontend's own status filter only ever offers OPEN/CLOSED/RESOLVING/
 * RESOLVED (DRAFT is never publicly listed; PAUSED/CANCELLED are dead
 * states) — this schema stays permissive so parsing never breaks if that
 * changes, without the UI inventing filter options the backend can't
 * actually produce today.
 */
export const MARKET_STATUSES = ["DRAFT", "OPEN", "PAUSED", "CLOSED", "RESOLVING", "RESOLVED", "CANCELLED"] as const;
export const MarketStatusSchema = z.enum(MARKET_STATUSES);
export type MarketStatus = z.infer<typeof MarketStatusSchema>;

/** The subset a user is ever allowed to filter the public markets list by. */
export const MARKET_LIST_FILTER_STATUSES = ["OPEN", "CLOSED", "RESOLVING", "RESOLVED"] as const;
export type MarketListFilterStatus = (typeof MARKET_LIST_FILTER_STATUSES)[number];

export const MarketCategorySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type MarketCategory = z.infer<typeof MarketCategorySchema>;

/** Minimal market projection used when a market is embedded inside an Order/Position, to avoid unbounded nesting. */
export const MarketRefSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  status: MarketStatusSchema,
  closeTime: z.string().nullable(),
});
export type MarketRef = z.infer<typeof MarketRefSchema>;

export const MarketOutcomeSchema = z.object({
  id: z.string(),
  marketId: z.string(),
  key: z.string(),
  label: z.string(),
  sortOrder: z.number().int(),
  createdAt: z.string(),
});
export type MarketOutcome = z.infer<typeof MarketOutcomeSchema>;

export const MarketOutcomeWithMarketSchema = MarketOutcomeSchema.extend({
  market: MarketRefSchema,
});
export type MarketOutcomeWithMarket = z.infer<typeof MarketOutcomeWithMarketSchema>;

export const MarketSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  categoryId: z.string(),
  status: MarketStatusSchema,
  resolutionSource: z.string().nullable(),
  resolutionCriteria: z.string().nullable(),
  openTime: z.string().nullable(),
  closeTime: z.string().nullable(),
  resolutionTime: z.string().nullable(),
  maxExposure: z.string().nullable(),
  createdById: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  category: MarketCategorySchema,
  outcomes: z.array(MarketOutcomeSchema),
});
export type Market = z.infer<typeof MarketSchema>;

export const MarketListSchema = z.array(MarketSchema);

/**
 * GET /markets/:id/resolution — aggregate, public resolution/settlement
 * progress. Never a per-user payout figure (see MySettlementSchema below
 * for that).
 */
export const MarketResolutionStatusSchema = z.object({
  marketId: z.string(),
  status: MarketStatusSchema,
  resolution: z
    .object({
      winningOutcomeId: z.string(),
      winningOutcomeKey: z.string(),
      resolverId: z.string(),
      resolvedAt: z.string(),
      settledAt: z.string().nullable(),
      notes: z.string().nullable(),
    })
    .nullable(),
  settlement: z.object({
    settledPositions: z.number().int().nonnegative(),
    totalPositions: z.number().int().nonnegative(),
  }),
});
export type MarketResolutionStatus = z.infer<typeof MarketResolutionStatusSchema>;

/** GET /markets/:id/settlement/mine — the calling user's own settlement result(s) for one market. */
export const PositionSettlementSchema = z.object({
  id: z.string(),
  positionId: z.string(),
  marketId: z.string(),
  outcomeId: z.string(),
  userId: z.string(),
  quantity: z.string(),
  payoutPerShare: z.string(),
  payoutAmount: z.string(),
  ledgerTransactionId: z.string().nullable(),
  idempotencyKey: z.string(),
  settledAt: z.string(),
  outcome: z.object({ id: z.string(), key: z.string(), label: z.string() }),
});
export type PositionSettlement = z.infer<typeof PositionSettlementSchema>;
export const MySettlementsSchema = z.array(PositionSettlementSchema);

export const OrderBookLevelSchema = z.object({
  price: z.string(),
  quantity: z.string(),
});
export type OrderBookLevel = z.infer<typeof OrderBookLevelSchema>;

export const OrderBookViewSchema = z.object({
  marketId: z.string(),
  outcomeId: z.string(),
  /** Highest price first. */
  bids: z.array(OrderBookLevelSchema),
  /** Lowest price first. */
  asks: z.array(OrderBookLevelSchema),
  asOf: z.string(),
});
export type OrderBookView = z.infer<typeof OrderBookViewSchema>;

export const ORDER_STATUSES = ["OPEN", "PARTIALLY_FILLED", "FILLED", "CANCELLED", "EXPIRED", "REJECTED"] as const;
export const OrderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  userId: z.string(),
  marketId: z.string(),
  outcomeId: z.string(),
  side: OrderSideSchema,
  type: OrderTypeSchema,
  price: z.string().nullable(),
  quantity: z.string(),
  filledQuantity: z.string(),
  remainingQuantity: z.string(),
  status: OrderStatusSchema,
  clientOrderId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Only present on the paginated "my orders" endpoint, not every caller.
  market: MarketRefSchema.optional(),
  outcome: MarketOutcomeSchema.optional(),
});
export type Order = z.infer<typeof OrderSchema>;

export const PaginatedOrdersSchema = z.object({
  items: z.array(OrderSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type PaginatedOrders = z.infer<typeof PaginatedOrdersSchema>;

/** Response of POST /trading/orders and /trading/orders/:id/retry-matching. */
export const OrderPlacementResultSchema = z.object({
  orderId: z.string(),
  status: OrderStatusSchema,
  side: OrderSideSchema,
  quantity: z.string(),
  filledQuantity: z.string(),
  remainingQuantity: z.string(),
  fills: z.array(
    z.object({
      fillId: z.string(),
      price: z.string(),
      quantity: z.string(),
      executedAt: z.string(),
    }),
  ),
  averageExecutionPrice: z.string().nullable(),
  reservedAmountRemaining: z.string(),
  /**
   * True only when the immediate post-placement matching attempt failed —
   * the order itself is still real, funded, and resting (never a
   * placement failure). Absent on the ordinary path.
   */
  matchingDeferred: z.boolean().optional(),
});
export type OrderPlacementResult = z.infer<typeof OrderPlacementResultSchema>;

/**
 * GET /trading/fills — the caller's own side of each execution only.
 * `side`/`orderId`/`isMaker` are always relative to the calling user; the
 * counterparty's identity and order id are never included in this shape.
 */
export const FillSchema = z.object({
  fillId: z.string(),
  marketId: z.string(),
  outcomeId: z.string(),
  orderId: z.string(),
  side: OrderSideSchema,
  isMaker: z.boolean(),
  price: z.string(),
  quantity: z.string(),
  fee: z.string(),
  executedAt: z.string(),
});
export type Fill = z.infer<typeof FillSchema>;

export const PaginatedFillsSchema = z.object({
  items: z.array(FillSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type PaginatedFills = z.infer<typeof PaginatedFillsSchema>;

/**
 * GET /trading/positions. `settlement` is present only once the position's
 * market has actually settled it (see PositionSettlementSchema above) —
 * never a frontend-computed payout.
 */
export const PositionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  marketId: z.string(),
  outcomeId: z.string(),
  quantity: z.string(),
  reservedQuantity: z.string(),
  avgPrice: z.string(),
  realizedPnl: z.string(),
  settledAt: z.string().nullable(),
  updatedAt: z.string(),
  outcome: MarketOutcomeWithMarketSchema.optional(),
});
export type Position = z.infer<typeof PositionSchema>;

export const PositionListSchema = z.array(PositionSchema);
