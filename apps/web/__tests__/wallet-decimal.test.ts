import { compareDecimalStrings, decimalPlaces, subtractDecimalStrings } from "../lib/wallet/decimal";

describe("subtractDecimalStrings", () => {
  it("subtracts two whole numbers", () => {
    expect(subtractDecimalStrings("100", "5")).toBe("95");
  });

  it("returns the same amount when the fee is zero — the common case today", () => {
    expect(subtractDecimalStrings("100", "0")).toBe("100");
  });

  it("handles differing decimal scales without floating-point drift", () => {
    // 100 - 0.1 === 99.9 exactly, never 99.89999999999999 (a real float bug).
    expect(subtractDecimalStrings("100", "0.1")).toBe("99.9");
  });

  it("trims trailing zeros from the fractional part", () => {
    expect(subtractDecimalStrings("1.50", "0.50")).toBe("1");
  });

  it("produces zero without a stray negative sign when the operands are equal", () => {
    expect(subtractDecimalStrings("5", "5")).toBe("0");
  });

  it("never produces a negative estimated-received figure in the normal fee < amount case", () => {
    expect(subtractDecimalStrings("1000", "1")).toBe("999");
  });
});

describe("compareDecimalStrings / decimalPlaces (Phase 36)", () => {
  it("compares exactly where Number() cannot", () => {
    // Number("1.0000000000000000001") === Number("1") — a float compare would call these equal.
    expect(compareDecimalStrings("1.0000000000000000001", "1")).toBe(1);
    expect(compareDecimalStrings("1", "1.0000000000000000001")).toBe(-1);
    expect(compareDecimalStrings("100.50", "100.5")).toBe(0);
    expect(compareDecimalStrings("0", "0.0")).toBe(0);
  });

  it("counts significant decimal places like Prisma.Decimal", () => {
    expect(decimalPlaces("1")).toBe(0);
    expect(decimalPlaces("1.50")).toBe(1);
    expect(decimalPlaces("0.000001")).toBe(6);
    expect(decimalPlaces("1.0000001")).toBe(7);
  });
});
