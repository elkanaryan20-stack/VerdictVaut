import { Prisma } from "@prisma/client";

export interface WithdrawalFeeContext {
  assetSymbol: string;
  networkCode: string;
  /** The requested withdrawal amount — the total that will be debited from the user's balance. */
  amount: Prisma.Decimal;
}

export interface WithdrawalFeeResult {
  /**
   * Deducted FROM `amount`, never added on top of it — the user's
   * reservation/debit is always exactly the `amount` they requested; the
   * fee only affects how much of that actually reaches the chain (see
   * `estimatedReceived` = amount - fee). Zero is a real, honest answer,
   * not a placeholder.
   */
  fee: Prisma.Decimal;
}

/**
 * The one seam for whatever withdrawal fee the platform ever charges —
 * mirrors trading's FeeCalculator interface exactly (see
 * fee-calculator.interface.ts). Nothing in WithdrawalsService computes a
 * fee inline; it asks this interface, so a future fee schedule (flat,
 * percentage, network-cost-based, asset/network-specific) never means
 * rewriting the withdrawal state machine or its reservation math. Any
 * non-zero fee this returns is posted through the ledger as an explicit
 * FEE_REVENUE leg at settlement time (see WithdrawalsService's
 * completion posting) — never deducted ad hoc.
 */
export interface WithdrawalFeeCalculator {
  calculateWithdrawalFee(context: WithdrawalFeeContext): WithdrawalFeeResult;
}

export const WITHDRAWAL_FEE_CALCULATOR = Symbol("WithdrawalFeeCalculator");
