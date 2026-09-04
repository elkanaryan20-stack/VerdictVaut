import { Prisma } from "@prisma/client";

/**
 * Pure balance arithmetic, isolated from Prisma/DB calls so the critical
 * rules — balances may never go negative, reservations may never exceed
 * what's available — are unit-testable without a live database.
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

/** Funds not already earmarked by an active FundReservation. */
export function computeAvailableBalance(
  cachedBalance: Prisma.Decimal,
  reservedBalance: Prisma.Decimal,
): Prisma.Decimal {
  return cachedBalance.minus(reservedBalance);
}

export function sumAmounts(amounts: Prisma.Decimal.Value[]): Prisma.Decimal {
  return amounts.reduce((total: Prisma.Decimal, next) => total.plus(next), new Prisma.Decimal(0));
}

export function isZero(value: Prisma.Decimal): boolean {
  return value.isZero();
}
