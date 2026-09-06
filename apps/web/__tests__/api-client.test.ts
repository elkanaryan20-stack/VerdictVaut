import { apiFetch, ApiError } from "../lib/api-client";
import { clearTokens, getAccessToken, setTokens } from "../lib/auth/token-storage";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as Response;
}

describe("apiFetch", () => {
  beforeEach(() => {
    clearTokens();
    (global.fetch as jest.Mock) = jest.fn();
  });

  it("attaches the stored access token as a Bearer header", async () => {
    setTokens({ accessToken: "access-123", refreshToken: "refresh-123" });
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { ok: true }));

    await apiFetch("/wallet/balances");

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer access-123");
  });

  it("makes no Authorization header when there is no stored token", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { ok: true }));
    await apiFetch("/markets");
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("throws a typed ApiError with the backend's message on failure", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(404, { message: "Deposit not found" }));
    await expect(apiFetch("/wallet/deposits/x")).rejects.toMatchObject({ status: 404, message: "Deposit not found" });
  });

  it("transparently refreshes once on a 401 and retries the original request", async () => {
    setTokens({ accessToken: "stale-access", refreshToken: "refresh-123" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse(401, { message: "Unauthorized" })) // original request
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: "fresh-access", refreshToken: "fresh-refresh" })) // refresh call
      .mockResolvedValueOnce(jsonResponse(200, { balance: "100" })); // retried original request

    const result = await apiFetch<{ balance: string }>("/wallet/balances");

    expect(result).toEqual({ balance: "100" });
    expect(getAccessToken()).toBe("fresh-access");

    const retryCall = (global.fetch as jest.Mock).mock.calls[2];
    expect(retryCall[1].headers.Authorization).toBe("Bearer fresh-access");
  });

  it("clears tokens and throws 401 when the refresh token itself is invalid, without looping forever", async () => {
    setTokens({ accessToken: "stale-access", refreshToken: "dead-refresh" });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(jsonResponse(401, { message: "Unauthorized" })) // original
      .mockResolvedValueOnce(jsonResponse(401, { message: "Invalid refresh token" })); // refresh attempt fails

    await expect(apiFetch("/wallet/balances")).rejects.toMatchObject({ status: 401 });
    expect(getAccessToken()).toBeNull();
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(2); // never retries a third time
  });

  it("never attaches a token for a skipAuth call (e.g. login itself)", async () => {
    setTokens({ accessToken: "access-123", refreshToken: "refresh-123" });
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(200, { ok: true }));
    await apiFetch("/auth/login", { method: "POST", skipAuth: true, body: "{}" });
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("classifies rate-limit and server errors via the typed ApiError helpers", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(jsonResponse(429, { message: "Too many requests" }));
    try {
      await apiFetch("/auth/login", { method: "POST", skipAuth: true, body: "{}" });
      fail("expected apiFetch to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).isRateLimited).toBe(true);
    }
  });
});
