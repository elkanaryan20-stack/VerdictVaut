import { formatAmount, formatExactAmount, truncateMiddle } from "../lib/format";

describe("formatAmount", () => {
  it("groups thousands and trims trailing zeros", () => {
    expect(formatAmount("1234567.500000")).toBe("1,234,567.5");
  });

  it("truncates to the max decimals without rounding up", () => {
    expect(formatAmount("1.123456789", 4)).toBe("1.1234");
  });

  it("handles a whole number with no fraction", () => {
    expect(formatAmount("100")).toBe("100");
  });

  it("handles zero", () => {
    expect(formatAmount("0")).toBe("0");
  });

  it("preserves a negative sign", () => {
    expect(formatAmount("-42.5")).toBe("-42.5");
  });
});

describe("formatExactAmount", () => {
  it("never truncates decimals, only groups the whole part", () => {
    expect(formatExactAmount("1234567.123456789012345678")).toBe("1,234,567.123456789012345678");
  });
});

describe("truncateMiddle", () => {
  it("shortens a long hash with an ellipsis", () => {
    const result = truncateMiddle("0x1234567890abcdef1234567890abcdef12345678");
    expect(result).toContain("…");
    expect(result.startsWith("0x123456")).toBe(true);
  });

  it("leaves a short value untouched", () => {
    expect(truncateMiddle("short")).toBe("short");
  });
});
