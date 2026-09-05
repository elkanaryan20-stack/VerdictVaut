/**
 * The seam a future matcher plugs into. Deliberately not implemented in
 * this phase — see NotImplementedMatchingEngine.
 *
 * Ownership boundary (this is the point of the interface, not a detail):
 * the matcher decides WHICH resting orders cross and at what price/
 * quantity. It must never itself touch a user balance, post a ledger
 * entry, move a deposit/withdrawal, hold custody, or run settlement.
 * Those stay inside LedgerService/ReservationService/PositionReservation
 * Service, called by a separate execution/trading coordinator that takes
 * the matcher's output (a proposed execution) and — inside one
 * authoritative transaction — creates the Fill, consumes the reservation,
 * and updates positions. The matcher only ever answers "what would
 * execute", never "make it so".
 */
export interface OrderBookSnapshot {
  marketId: string;
  outcomeId: string;
  bids: Array<{ orderId: string; price: string; remainingQuantity: string; createdAt: Date }>;
  asks: Array<{ orderId: string; price: string; remainingQuantity: string; createdAt: Date }>;
}

export interface ProposedExecution {
  buyOrderId: string;
  sellOrderId: string;
  price: string;
  quantity: string;
}

export interface MatchingEngine {
  /** Register a newly-placed resting order with the book. */
  submit(orderId: string): Promise<void>;
  /** Remove a cancelled/expired order from the book. */
  cancel(orderId: string): Promise<void>;
  /** Compute (but do not execute) crossing opportunities for a book. */
  match(snapshot: OrderBookSnapshot): Promise<ProposedExecution[]>;
}

// TypeScript interfaces don't exist at runtime, so NestJS DI needs an
// explicit token to bind an interface to an implementation.
export const MATCHING_ENGINE = Symbol("MatchingEngine");
