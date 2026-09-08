/**
 * Shared cursor encoding for the Bitcoin/Solana/XRP deposit adapters
 * (Phase 11 fix — see git history for the "fixed page size can silently
 * miss deposits" finding this replaces).
 *
 * Unlike the EVM adapter (whose cursor is a single block number), these
 * three chains' transaction-history APIs are queried per-address, so a
 * real resume point needs one last-seen transaction id PER watched
 * address. This packs that into the single opaque cursor string
 * BlockchainWatchCursor.lastScannedPointer already stores.
 *
 * A pre-Phase-11 cursor was a bare ISO timestamp (not JSON) — parsing
 * that throws here and is treated as "no address history known yet"
 * rather than crashing the scan, so the upgrade needs no migration.
 */
export type PerAddressCursor = Record<string, string>;

export function parsePerAddressCursor(cursor: string | null): PerAddressCursor {
  if (!cursor) return {};
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PerAddressCursor;
    }
  } catch {
    // Pre-Phase-11 (or otherwise unrecognized) cursor format — treat as empty.
  }
  return {};
}

export function serializePerAddressCursor(cursor: PerAddressCursor): string {
  return JSON.stringify(cursor);
}
