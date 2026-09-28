import { ApiError } from "../lib/api-client";
import { shouldRetry } from "../lib/query-provider";

describe("query retry policy (Phase 38)", () => {
  it("never auto-retries a 429 — the server asked the client to back off", () => {
    expect(shouldRetry(0, new ApiError(429, "Too many requests"))).toBe(false);
  });

  it("never retries auth/ownership/not-found failures", () => {
    for (const status of [401, 403, 404]) {
      expect(shouldRetry(0, new ApiError(status, "x"))).toBe(false);
    }
  });

  it("retries a transient server/network failure at most twice", () => {
    expect(shouldRetry(0, new ApiError(503, "unavailable"))).toBe(true);
    expect(shouldRetry(1, new ApiError(0, "network"))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, "unavailable"))).toBe(false);
  });
});
