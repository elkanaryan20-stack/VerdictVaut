import { rawUnitsToDecimalString } from "./decimal-units.util";

describe("rawUnitsToDecimalString", () => {
  it("converts satoshis to BTC (8 decimals)", () => {
    expect(rawUnitsToDecimalString(150000000n, 8)).toBe("1.5");
  });

  it("converts wei to ETH (18 decimals)", () => {
    expect(rawUnitsToDecimalString("1000000000000000000", 18)).toBe("1");
  });

  it("handles a value smaller than one whole unit", () => {
    expect(rawUnitsToDecimalString(500n, 6)).toBe("0.0005");
  });

  it("handles zero", () => {
    expect(rawUnitsToDecimalString(0n, 8)).toBe("0");
  });

  it("handles an asset with zero decimals", () => {
    expect(rawUnitsToDecimalString(42n, 0)).toBe("42");
  });

  it("preserves precision beyond Number.MAX_SAFE_INTEGER (wei-scale amounts)", () => {
    // 123456789012345678 wei — well past 2^53 — must not lose precision via a float round-trip.
    expect(rawUnitsToDecimalString("123456789012345678", 18)).toBe("0.123456789012345678");
  });

  it("handles a negative value", () => {
    expect(rawUnitsToDecimalString(-250n, 2)).toBe("-2.5");
  });

  it("accepts a numeric string input", () => {
    expect(rawUnitsToDecimalString("1000000", 6)).toBe("1");
  });
});
