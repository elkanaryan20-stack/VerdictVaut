import { Prisma } from "@prisma/client";

export interface FeeContext {
  marketId: string;
  outcomeId: string;
  price: Prisma.Decimal;
  quantity: Prisma.Decimal;
}

/**
 * The one seam for every fee the platform ever charges — maker, taker,
 * market-specific, or platform-wide. Nothing in the order lifecycle
 * computes a fee inline; it asks this interface, so a future fee
 * schedule change never means rewriting OrdersService or the reservation
 * math. Any fee this returns must still be posted through the ledger
 * (LedgerTransactionType.FEE, credited to the FEE_REVENUE house account)
 * — never deducted ad hoc.
 */
export interface FeeCalculator {
  /**
   * Conservative fee estimate to add to a BUY order's cash reservation at
   * placement time — before a matcher exists, whether this order will end
   * up "maker" or "taker" is unknown, so implementations should return
   * the higher of the two if they ever differ.
   */
  estimateBuyReserveFee(context: FeeContext): Prisma.Decimal;
}

// TypeScript interfaces don't exist at runtime, so NestJS DI needs an
// explicit token to bind an interface to an implementation.
export const FEE_CALCULATOR = Symbol("FeeCalculator");
