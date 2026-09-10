// Attempts at/below this count are never throttled at all — ordinary
// typos must never be punished. Only once a real credential-stuffing
// pattern emerges (more than this many consecutive failures) does any
// delay kick in.
const LOCK_THRESHOLD = 5;
const BASE_LOCK_MS = 60_000; // 1 minute
// Bounded: this is a temporary throttle, never a lockout an attacker
// could use to deny a real user access indefinitely just by guessing
// their email and submitting a few wrong passwords.
const MAX_LOCK_MS = 15 * 60_000; // 15 minutes

/**
 * Exponential backoff, capped — 0 while at/under the threshold, then
 * 1, 2, 4, 8, 15 (capped), 15, 15... minutes as failures keep coming.
 * Pure function: no I/O, trivially unit-testable and reused identically
 * by every caller so the policy is defined in exactly one place.
 */
export function computeLockDurationMs(failedLoginAttempts: number): number {
  if (failedLoginAttempts <= LOCK_THRESHOLD) return 0;
  const exponent = failedLoginAttempts - LOCK_THRESHOLD - 1;
  return Math.min(BASE_LOCK_MS * 2 ** exponent, MAX_LOCK_MS);
}

export function isCurrentlyLocked(lockedUntil: Date | null, now: Date = new Date()): boolean {
  return lockedUntil != null && lockedUntil.getTime() > now.getTime();
}
