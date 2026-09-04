import { Prisma } from "@prisma/client";

/**
 * Pure balance arithmetic, isolated from Prisma/DB calls so the critical
 * rule — balances may never go negative — is unit-testable without a
 * live database.
 */
export function computeBalanceAfter(
  currentBalance: Prisma.Decimal,
  amount: Prisma.Decimal,
): Prisma.Decimal {
  return currentBalance.plus(amount);
}

export function isNegative(balance: Prisma.Decimal): boolean {
  return balance.isNegative();
}
