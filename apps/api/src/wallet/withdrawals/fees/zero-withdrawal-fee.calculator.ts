import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { WithdrawalFeeCalculator, WithdrawalFeeContext, WithdrawalFeeResult } from "./withdrawal-fee-calculator.interface";

/**
 * Default implementation while no production withdrawal fee schedule
 * has been approved. Returning zero is a real, honest answer — not a
 * placeholder that lies about cost — and swapping in a real schedule
 * (flat, percentage, or network-cost-based) later means implementing
 * this interface again, not touching WithdrawalsService.
 */
@Injectable()
export class ZeroWithdrawalFeeCalculator implements WithdrawalFeeCalculator {
  calculateWithdrawalFee(_context: WithdrawalFeeContext): WithdrawalFeeResult {
    return { fee: new Prisma.Decimal(0) };
  }
}
