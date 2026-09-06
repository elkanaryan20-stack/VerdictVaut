/**
 * String-based formatting only — amounts arriving from the backend are
 * decimal strings specifically so nothing in this app ever round-trips
 * them through `Number()` and risks precision loss, including here,
 * where the only goal is a nicer-looking label, never a value fed back
 * into any calculation or request.
 */
function splitSign(value: string): { negative: boolean; unsigned: string } {
  const negative = value.startsWith("-");
  return { negative, unsigned: negative ? value.slice(1) : value };
}

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Rounded for compact display (e.g. a balance card) — never used for anything but a label. */
export function formatAmount(value: string, maxDecimals = 6): string {
  const { negative, unsigned } = splitSign(value);
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const truncated = fraction.slice(0, maxDecimals).replace(/0+$/, "");
  const result = truncated ? `${groupThousands(whole)}.${truncated}` : groupThousands(whole);
  return negative ? `-${result}` : result;
}

/** Full precision, only thousands-grouped — for a specific transaction record where every digit matters. */
export function formatExactAmount(value: string): string {
  const { negative, unsigned } = splitSign(value);
  const [whole = "0", fraction] = unsigned.split(".");
  const result = fraction ? `${groupThousands(whole)}.${fraction}` : groupThousands(whole);
  return negative ? `-${result}` : result;
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function truncateMiddle(value: string, headLength = 8, tailLength = 6): string {
  if (value.length <= headLength + tailLength + 3) return value;
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}
