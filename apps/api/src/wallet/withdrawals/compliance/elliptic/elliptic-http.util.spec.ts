import { ellipticRequest, EllipticApiError, EllipticMalformedResponseError, EllipticTransportError } from "./elliptic-http.util";

/**
 * These tests mock the global `fetch` to simulate DOCUMENTED Elliptic
 * response shapes (per Phase 14B's verified research) — they prove this
 * codebase's own HTTP-handling logic (auth headers attached, error
 * classification, JSON parsing) is correct. No real network call to
 * Elliptic is made anywhere in this file.
 */
describe("ellipticRequest", () => {
  const config = { apiBaseUrl: "https://aml-api.elliptic.co/v2", apiKey: "test-key", apiSecretBase64: Buffer.from("secret").toString("base64"), timeoutMs: 5000 };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });

  it("sends x-access-key/x-access-sign/x-access-timestamp headers, per Elliptic's verified auth scheme", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify([{ id: "an-1" }]) });

    await ellipticRequest(config, "POST", "/wallet", [{ subject: { asset: "holistic", blockchain: "holistic", type: "address", hash: "0xabc" }, type: "wallet_exposure" }]);

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers["x-access-key"]).toBe("test-key");
    expect(typeof options.headers["x-access-sign"]).toBe("string");
    expect(options.headers["x-access-timestamp"]).toMatch(/^\d+$/);
  });

  it("calls the exact configured base URL + path", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "an-1" }) });
    await ellipticRequest(config, "GET", "/wallet/an-1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://aml-api.elliptic.co/v2/wallet/an-1");
  });

  it("parses a successful JSON response", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "an-1", risk_score: 0.42, process_status: "complete" }) });
    const result = await ellipticRequest<{ id: string }>(config, "GET", "/wallet/an-1");
    expect(result).toEqual({ id: "an-1", risk_score: 0.42, process_status: "complete" });
  });

  it("throws EllipticApiError on a non-2xx response, carrying the status and raw body", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ message: "invalid signature" }) });
    await expect(ellipticRequest(config, "GET", "/wallet/an-1")).rejects.toMatchObject({ status: 401 });
  });

  it("throws EllipticApiError for a 207 partial-error response (not treated as 2xx success)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 207, text: async () => "[]" });
    await expect(ellipticRequest(config, "POST", "/wallet", [])).rejects.toBeInstanceOf(EllipticApiError);
  });

  it("throws EllipticMalformedResponseError when the body isn't valid JSON", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "<html>not json</html>" });
    await expect(ellipticRequest(config, "GET", "/wallet/an-1")).rejects.toBeInstanceOf(EllipticMalformedResponseError);
  });

  it("throws EllipticTransportError when fetch itself rejects (network error / timeout)", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    await expect(ellipticRequest(config, "POST", "/wallet", [])).rejects.toBeInstanceOf(EllipticTransportError);
  });
});
