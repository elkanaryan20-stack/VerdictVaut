import { Prisma } from "@prisma/client";
import { computeAvailableBalance, computeBalanceAfter, isNegative, isZero, sumAmounts } from "./balance.util";

describe("balance.util", () => {
  describe("computeBalanceAfter", () => {
    it("adds a positive amount to the current balance", () => {
      const result = computeBalanceAfter(new Prisma.Decimal("100.5"), new Prisma.Decimal("25.25"));
      expect(result.toString()).toBe("125.75");
    });

    it("subtracts when the amount is negative", () => {
      const result = computeBalanceAfter(new Prisma.Decimal("100"), new Prisma.Decimal("-40"));
      expect(result.toString()).toBe("60");
    });

    it("supports high-precision crypto amounts without rounding drift", () => {
      const result = computeBalanceAfter(
        new Prisma.Decimal("0.000000000000000001"),
        new Prisma.Decimal("0.000000000000000002"),
      );
      expect(result.toFixed(18)).toBe("0.000000000000000003");
    });
  });

  describe("isNegative", () => {
    it("flags a negative balance", () => {
      expect(isNegative(new Prisma.Decimal("-0.01"))).toBe(true);
    });

    it("treats exactly zero as not negative", () => {
      expect(isNegative(new Prisma.Decimal("0"))).toBe(false);
    });

    it("does not flag a positive balance", () => {
      expect(isNegative(new Prisma.Decimal("1"))).toBe(false);
    });
  });

  describe("computeAvailableBalance", () => {
    it("subtracts reserved from cached balance", () => {
      const result = computeAvailableBalance(new Prisma.Decimal("100"), new Prisma.Decimal("30"));
      expect(result.toString()).toBe("70");
    });

    it("can go negative if reservedBalance exceeds cachedBalance (a bug elsewhere, not this function's job to hide)", () => {
      const result = computeAvailableBalance(new Prisma.Decimal("10"), new Prisma.Decimal("30"));
      expect(result.toString()).toBe("-20");
    });
  });

  describe("sumAmounts", () => {
    it("sums a list of decimals to zero for a balanced set of postings", () => {
      const result = sumAmounts([new Prisma.Decimal("100"), new Prisma.Decimal("-100")]);
      expect(isZero(result)).toBe(true);
    });

    it("detects an unbalanced set of postings", () => {
      const result = sumAmounts([new Prisma.Decimal("100"), new Prisma.Decimal("-99")]);
      expect(isZero(result)).toBe(false);
      expect(result.toString()).toBe("1");
    });

    it("returns zero for an empty list", () => {
      expect(sumAmounts([]).toString()).toBe("0");
    });
  });
});
