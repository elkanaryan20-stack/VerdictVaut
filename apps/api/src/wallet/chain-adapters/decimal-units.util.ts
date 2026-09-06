/**
 * Chains report native/token amounts as integer base units (satoshis,
 * wei, lamports, drops) — converting those to the Decimal asset amount
 * this domain stores everywhere else is pure arithmetic with no chain
 * knowledge, so it lives here rather than duplicated per adapter.
 * Deliberately string-based (never Number) to avoid float precision loss
 * on amounts that can exceed Number.MAX_SAFE_INTEGER (e.g. wei).
 */
export function rawUnitsToDecimalString(rawUnits: bigint | string, decimals: number): string {
  const value = typeof rawUnits === "bigint" ? rawUnits : BigInt(rawUnits);
  const negative = value < 0n;
  const abs = negative ? -value : value;

  const digits = abs.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  const fraction = (decimals > 0 ? digits.slice(digits.length - decimals) : "").replace(/0+$/, "");

  const unsigned = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${unsigned}` : unsigned;
}
