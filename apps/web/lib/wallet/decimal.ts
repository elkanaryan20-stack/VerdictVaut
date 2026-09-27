/**
 * String-based decimal subtract for exactly one purpose: deriving
 * "estimated received" (amount - fee) for display on an already-created
 * Withdrawal, where BOTH operands are real, backend-confirmed decimal
 * strings (never a user-typed estimate) — stronger footing than
 * lib/trading/decimal.ts's multiplyDecimalStrings, which estimates from
 * not-yet-submitted input. Never used to recompute or override a
 * backend-returned figure for anything but a label, and never fed back
 * into a request. No `Number()` round-trip, so no floating-point
 * precision loss.
 */
function parseDecimal(value: string): { negative: boolean; digits: bigint; scale: number } {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = BigInt((whole || "0") + fraction || "0");
  return { negative, digits, scale: fraction.length };
}

export function subtractDecimalStrings(a: string, b: string): string {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const scale = Math.max(pa.scale, pb.scale);
  const scaledA = pa.digits * 10n ** BigInt(scale - pa.scale) * (pa.negative ? -1n : 1n);
  const scaledB = pb.digits * 10n ** BigInt(scale - pb.scale) * (pb.negative ? -1n : 1n);
  const diff = scaledA - scaledB;

  const negative = diff < 0n;
  const absDiff = negative ? -diff : diff;
  const digitsStr = absDiff.toString().padStart(scale + 1, "0");
  const whole = scale > 0 ? digitsStr.slice(0, digitsStr.length - scale) : digitsStr;
  const fraction = scale > 0 ? digitsStr.slice(digitsStr.length - scale) : "";
  const trimmedFraction = fraction.replace(/0+$/, "");
  const result = trimmedFraction ? `${whole}.${trimmedFraction}` : whole;

  return negative && absDiff !== 0n ? `-${result}` : result;
}

/**
 * Phase 36 — exact comparison of two decimal strings (BigInt-scaled, never
 * Number()), for client-side pre-validation that must agree with the
 * backend's Prisma.Decimal checks at every precision.
 */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const diff = subtractDecimalStrings(a, b);
  if (/^0(\.0*)?$/.test(diff)) return 0;
  return diff.startsWith("-") ? -1 : 1;
}

/** Significant digits after the decimal point (trailing zeros ignored) — the same count as the backend's Prisma.Decimal.decimalPlaces(). */
export function decimalPlaces(value: string): number {
  const fraction = value.split(".")[1] ?? "";
  return fraction.replace(/0+$/, "").length;
}
