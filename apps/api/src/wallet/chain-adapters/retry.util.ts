export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

// Bounded on purpose (requirement #8: "do not retry forever") -- 1
// initial attempt + 3 retries, capped exponential backoff. A provider
// that is genuinely down for longer than this must surface as a real
// error to the caller (which, for a scan, means the cursor is never
// advanced -- see DepositWatcherService), not hang a poll indefinitely.
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded retry with exponential backoff + full jitter, for transient
 * chain-provider failures (timeout, rate limit, 5xx, network error).
 *
 * NEVER wrap a call whose result legitimately encodes "not found" as
 * data rather than an exception -- every adapter/provider in this
 * codebase already makes that distinction itself (see fetchJson's,
 * fetchJsonRpc's, and callRippled's own docblocks: a 404 / txnNotFound /
 * actNotFound is returned as a normal value by the CALLER after
 * inspecting the response, never thrown from inside this helper's target
 * function) -- so retrying every thrown error here is safe and correct:
 * anything that reaches this catch block is a genuine transport/provider
 * failure, not a chain-level "no such transaction" answer.
 *
 * Full jitter (AWS's recommended strategy: a uniformly random delay
 * between 0 and the exponential cap, not a small jitter added on top of
 * the cap) spreads concurrent workers' retries out enough to avoid a
 * thundering herd all retrying against the same rate-limited provider in
 * lockstep.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.random() * cap);
    }
  }
  throw lastError;
}
