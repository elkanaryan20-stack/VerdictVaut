import { withRetry } from "./retry.util";

describe("withRetry", () => {
  it("returns the result on the first successful attempt without retrying", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds once the underlying call recovers", async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce("ok");
    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("never retries forever — gives up and throws the last error after maxAttempts", async () => {
    const error = new Error("provider down");
    const fn = jest.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow("provider down");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects a custom maxAttempts of 1 (no retries at all)", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("boom"));
    await expect(withRetry(fn, { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("waits between attempts (does not busy-loop) — total elapsed time reflects the jittered backoff delay", async () => {
    // Full jitter picks a random delay in [0, cap] — pin Math.random so
    // this assertion isn't itself flaky (a real random draw could
    // legitimately land near 0).
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(1);
    try {
      const fn = jest.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce("ok");
      const start = Date.now();
      await withRetry(fn, { baseDelayMs: 30, maxDelayMs: 30 });
      expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    } finally {
      randomSpy.mockRestore();
    }
  });
});
