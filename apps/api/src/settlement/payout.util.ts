import { Prisma } from "@prisma/client";

/**
 * The entire payout formula, isolated from Prisma/DB calls exactly like
 * ledger/balance.util.ts — a losing position's payoutPerShare is 0 (set
 * by ResolutionService for every non-winning outcome), a winning
 * position's is 1, so this one multiplication is the whole of "winners
 * get paid, losers get zero": there is no separate winner/loser branch
 * anywhere in the settlement code, only this rate.
 *
 * This is NOT Position.realizedPnl (ordinary trade P&L, realized the
 * instant shares change hands) and must never be confused with it — see
 * the field comments on Position and PositionSettlement.
 */
export function computeSettlementPayout(
  quantity: Prisma.Decimal.Value,
  payoutPerShare: Prisma.Decimal.Value,
): Prisma.Decimal {
  return new Prisma.Decimal(quantity).times(payoutPerShare);
}
