import { Prisma } from "@prisma/client";

export interface FeeContext {
  marketId: string;
  outcomeId: string;
  price: Prisma.Decimal;
  quantity: Prisma.Decimal;
}

export interface FillFeeContext extends FeeContext {
  /** Execution price/quantity of this specific fill — may differ from a resting order's own limit price (price improvement). */
  makerUserId: string;
  takerUserId: string;
}

export interface FillFeeResult {
  /** Fee charged to the buyer, in the settlement asset. Zero means no fee leg is posted for this side. */
  buyerFee: Prisma.Decimal;
  /** Fee charged to the seller, in the settlement asset. Zero means no fee leg is posted for this side. */
  sellerFee: Prisma.Decimal;
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

  /**
   * The actual fee(s) to charge for one real execution, computed by the
   * ExecutionCoordinator at fill time and posted through LedgerService as
   * explicit FEE-type postings to FEE_REVENUE. The matching engine never
   * calls this and never knows fees exist — fees are entirely a
   * settlement-time concern layered on top of a fee-agnostic match.
   */
  calculateFillFee(context: FillFeeContext): FillFeeResult;
}

// TypeScript interfaces don't exist at runtime, so NestJS DI needs an
// explicit token to bind an interface to an implementation.
export const FEE_CALCULATOR = Symbol("FeeCalculator");
