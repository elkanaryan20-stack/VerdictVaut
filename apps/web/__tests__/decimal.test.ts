import { multiplyDecimalStrings } from "../lib/trading/decimal";

describe("multiplyDecimalStrings", () => {
  it("multiplies two whole numbers", () => {
    expect(multiplyDecimalStrings("10", "5")).toBe("50");
  });

  it("multiplies a price and quantity to produce a decimal-safe result", () => {
    // 0.1 * 3 === 0.30000000000000004 in floating point — this must not happen.
    expect(multiplyDecimalStrings("0.1", "3")).toBe("0.3");
  });

  it("handles differing decimal scales", () => {
    expect(multiplyDecimalStrings("0.123", "10")).toBe("1.23");
  });

  it("trims trailing zeros from the fractional part", () => {
    expect(multiplyDecimalStrings("0.5", "2")).toBe("1");
    expect(multiplyDecimalStrings("0.50", "0.20")).toBe("0.1");
  });

  it("produces zero for a zero operand without a stray negative sign", () => {
    expect(multiplyDecimalStrings("0", "5")).toBe("0");
  });

  it("propagates a negative sign correctly", () => {
    expect(multiplyDecimalStrings("-2", "3")).toBe("-6");
    expect(multiplyDecimalStrings("-2", "-3")).toBe("6");
  });

  it("handles a realistic order-ticket estimate (price * quantity)", () => {
    expect(multiplyDecimalStrings("0.65", "1000")).toBe("650");
  });
});
