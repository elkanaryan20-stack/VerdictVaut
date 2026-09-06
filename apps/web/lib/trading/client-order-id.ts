/**
 * One stable id per submission ATTEMPT — generated once when the ticket
 * is opened/reset, never regenerated on retry (that's what makes a retry
 * of the same attempt idempotent server-side; see CreateOrderDto). A
 * fresh id is only ever requested after a terminal outcome (success,
 * final rejection, or the user explicitly starts a new order).
 */
function randomHex(byteLength: number): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let out = "";
  for (let i = 0; i < byteLength; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

export function generateClientOrderId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `coid-${Date.now()}-${randomHex(8)}`;
}
