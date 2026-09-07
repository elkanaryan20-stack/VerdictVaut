import { subtractDecimalStrings } from "../lib/wallet/decimal";

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
