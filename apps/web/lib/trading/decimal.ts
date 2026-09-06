/**
 * String-based decimal multiply for a single purpose: an "estimated
 * total" label in the order ticket (price × quantity) BEFORE the backend
 * has confirmed anything. Never used to recompute or override a
 * backend-returned figure (balances, fills, reservations) — those are
 * always displayed exactly as the API returns them. No `Number()`
 * round-trip, so no floating-point precision loss.
 */
function parseDecimal(value: string): { negative: boolean; digits: bigint; scale: number } {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const digits = BigInt((whole || "0") + fraction || "0");
  return { negative, digits, scale: fraction.length };
}

export function multiplyDecimalStrings(a: string, b: string): string {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  const product = pa.digits * pb.digits;
  const scale = pa.scale + pb.scale;

  const digitsStr = product.toString().padStart(scale + 1, "0");
  const whole = scale > 0 ? digitsStr.slice(0, digitsStr.length - scale) : digitsStr;
  const fraction = scale > 0 ? digitsStr.slice(digitsStr.length - scale) : "";
  const trimmedFraction = fraction.replace(/0+$/, "");
  const result = trimmedFraction ? `${whole}.${trimmedFraction}` : whole;

  const negative = pa.negative !== pb.negative && product !== 0n;
  return negative ? `-${result}` : result;
}
