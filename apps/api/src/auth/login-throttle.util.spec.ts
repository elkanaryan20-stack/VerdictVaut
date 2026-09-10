import { computeLockDurationMs, isCurrentlyLocked } from "./login-throttle.util";

describe("computeLockDurationMs", () => {
  it("returns 0 at and below the threshold — ordinary typos are never throttled", () => {
    expect(computeLockDurationMs(0)).toBe(0);
    expect(computeLockDurationMs(4)).toBe(0);
    expect(computeLockDurationMs(5)).toBe(0);
  });

  it("locks for 1 minute on the first attempt past the threshold", () => {
    expect(computeLockDurationMs(6)).toBe(60_000);
  });

  it("doubles with each further consecutive failure", () => {
    expect(computeLockDurationMs(7)).toBe(120_000);
    expect(computeLockDurationMs(8)).toBe(240_000);
  });

  it("is capped at 15 minutes no matter how many failures pile up — never a permanent lockout", () => {
    expect(computeLockDurationMs(20)).toBe(15 * 60_000);
    expect(computeLockDurationMs(1000)).toBe(15 * 60_000);
  });
});

describe("isCurrentlyLocked", () => {
  it("is false when lockedUntil is null", () => {
    expect(isCurrentlyLocked(null)).toBe(false);
  });

  it("is true while lockedUntil is in the future", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const lockedUntil = new Date("2026-01-01T00:05:00Z");
    expect(isCurrentlyLocked(lockedUntil, now)).toBe(true);
  });

  it("is false once lockedUntil has passed — the throttle expires on its own, no manual unlock needed", () => {
    const now = new Date("2026-01-01T00:10:00Z");
    const lockedUntil = new Date("2026-01-01T00:05:00Z");
    expect(isCurrentlyLocked(lockedUntil, now)).toBe(false);
  });
});
