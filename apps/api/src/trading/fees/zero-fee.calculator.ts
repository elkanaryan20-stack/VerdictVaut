import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { FeeCalculator, FeeContext } from "./fee-calculator.interface";

/**
 * Default implementation while the product fee schedule isn't finalized.
 * Returning zero is a real, honest answer — not a placeholder that lies
 * about cost — and swapping in a real schedule later (maker/taker,
 * market-specific, platform-wide) means implementing this interface
 * again, not touching the order lifecycle.
 */
@Injectable()
export class ZeroFeeCalculator implements FeeCalculator {
  estimateBuyReserveFee(_context: FeeContext): Prisma.Decimal {
    return new Prisma.Decimal(0);
  }
}
