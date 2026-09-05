import { Prisma } from "@prisma/client";
import { computeSettlementPayout } from "./payout.util";

describe("computeSettlementPayout", () => {
  it("pays a winning position quantity * 1 (full payout per share)", () => {
    expect(computeSettlementPayout("10", "1").toString()).toBe("10");
  });

  it("pays a losing position zero, regardless of quantity held", () => {
    expect(computeSettlementPayout("500", "0").toString()).toBe("0");
  });

  it("pays zero for a zero-quantity position, even at a winning rate", () => {
    expect(computeSettlementPayout("0", "1").toString()).toBe("0");
  });

  it("supports a fractional payout rate (e.g. a partial/graded resolution rate), not just 0 or 1", () => {
    expect(computeSettlementPayout("100", "0.5").toString()).toBe("50");
  });

  it("uses exact Decimal arithmetic — never floating point", () => {
    // 0.1 + 0.2 != 0.3 in IEEE-754; this exercises the same precision
    // hazard on the multiplication side instead of addition.
    const result = computeSettlementPayout("3", "0.1");
    expect(result.toString()).toBe("0.3");
    expect(result.plus("0.2").toString()).toBe("0.5");
  });

  it("handles large quantities with full precision, no rounding drift", () => {
    expect(computeSettlementPayout("123456.789012345678", "1").toString()).toBe("123456.789012345678");
  });

  it("accepts Prisma.Decimal inputs directly, not just strings", () => {
    expect(computeSettlementPayout(new Prisma.Decimal("7"), new Prisma.Decimal("1")).toString()).toBe("7");
  });
});
