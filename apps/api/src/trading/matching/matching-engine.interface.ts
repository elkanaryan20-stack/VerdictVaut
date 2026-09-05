import { OrderSide, Prisma } from "@prisma/client";

/**
 * Everything the matcher needs to know about one order — a plain snapshot,
 * not a live database handle. `sequence` (Order.sequence, a DB-assigned
 * bigserial) is the deterministic price-time-priority tie-breaker: it is
 * strictly increasing and assigned atomically at insert time, unlike
 * createdAt (millisecond resolution — routinely tied under concurrent
 * submission) or the order id (a UUID, deliberately non-sequential).
 */
export interface MatchCandidate {
  orderId: string;
  userId: string;
  side: OrderSide;
  price: Prisma.Decimal;
  remainingQuantity: Prisma.Decimal;
  sequence: bigint;
}

/**
 * One proposed execution between two orders. Plain data only — no
 * database client, no service reference — so it can be constructed,
 * logged, and compared without touching Postgres. `price`/`quantity` are
 * decimal strings (not Prisma.Decimal) so this type has zero dependency on
 * how the caller chooses to parse/serialize it.
 *
 * `idempotencyKey` is deterministic, derived only from the immutable
 * identity of the two orders (see PriceTimePriorityMatchingEngine) — the
 * SAME pair of orders regenerates the SAME key on every call, so a retry
 * or a re-derivation from a fresher snapshot can never double-apply
 * (enforced by the DB unique constraint on Fill.idempotencyKey, not by
 * caller discipline).
 */
export interface ExecutionInstruction {
  idempotencyKey: string;
  marketId: string;
  outcomeId: string;
  buyOrderId: string;
  sellOrderId: string;
  /** MAKER = the resting order (its price is the execution price). */
  makerOrderId: string;
  /** TAKER = the incoming order that crossed the maker. */
  takerOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  price: string;
  quantity: string;
}

/**
 * The matcher itself: a deterministic, synchronous, side-effect-free
 * function from (incoming order, resting opposite-side candidates) to a
 * proposed sequence of executions. It never touches the database, never
 * mutates balances/positions, never creates records, never knows fees or
 * settlement exist.
 *
 * This intentionally departs from the Phase 2 stub's `submit`/`cancel`/
 * async `match(snapshot)` shape: those implied a stateful, in-memory order
 * book service that owns order lifecycle events, which contradicts "no
 * separate mutable order-book database as a second source of truth"
 * (Postgres is the only order book) and "keep the matcher as close to a
 * pure function as practical". The caller (ExecutionCoordinator) is
 * responsible for reading current resting orders from Postgres, invoking
 * this synchronously, and applying the results — the matcher itself holds
 * no state between calls.
 *
 * Candidate generation vs. execution: this method only proposes what
 * *would* execute against the given snapshot. It is NOT the authority on
 * whether an instruction is still valid by the time it's applied — that
 * re-validation is the ExecutionCoordinator's job, executed per-instruction
 * inside its own transaction, since the snapshot passed in here can go
 * stale the instant another concurrent order is placed or cancelled.
 */
export interface MatchingEngine {
  match(
    marketId: string,
    outcomeId: string,
    incoming: MatchCandidate,
    restingOpposite: MatchCandidate[],
  ): ExecutionInstruction[];
}

// TypeScript interfaces don't exist at runtime, so NestJS DI needs an
// explicit token to bind an interface to an implementation.
export const MATCHING_ENGINE = Symbol("MatchingEngine");
