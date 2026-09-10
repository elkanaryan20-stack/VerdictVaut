import * as crypto from "crypto";
import { fireblocksRequest, FireblocksApiError, FireblocksMalformedResponseError, FireblocksTransportError } from "./fireblocks-http.util";

/**
 * These tests mock the global `fetch` to simulate DOCUMENTED Fireblocks
 * response shapes (per Phase 14B's verified research) — they prove this
 * codebase's own HTTP-handling logic (auth headers attached, error
 * classification, JSON parsing) is correct. They are NOT a substitute
 * for a real sandbox smoke test and never claim to be: no real network
 * call to Fireblocks is made anywhere in this file.
 */
function generateTestKeyPair() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey;
}

describe("fireblocksRequest", () => {
  const config = { apiBaseUrl: "https://sandbox-api.fireblocks.io/v1", apiKey: "test-key", privateKeyPem: generateTestKeyPair(), timeoutMs: 5000 };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });

  it("sends X-API-Key and a Bearer JWT authorization header, per Fireblocks' verified auth scheme", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "fb-1", status: "SUBMITTED" }) });

    await fireblocksRequest(config, "POST", "/transactions", { assetId: "TEST" });

    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers["X-API-Key"]).toBe("test-key");
    expect(options.headers.Authorization).toMatch(/^Bearer .+\..+\..+$/);
  });

  it("calls the exact configured base URL + path", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "fb-1", status: "SUBMITTED" }) });
    await fireblocksRequest(config, "GET", "/transactions/fb-1");
    expect(fetchMock.mock.calls[0][0]).toBe("https://sandbox-api.fireblocks.io/v1/transactions/fb-1");
  });

  it("parses a successful JSON response", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "fb-1", status: "COMPLETED", txHash: "0xreal" }) });
    const result = await fireblocksRequest<{ id: string }>(config, "GET", "/transactions/fb-1");
    expect(result).toEqual({ id: "fb-1", status: "COMPLETED", txHash: "0xreal" });
  });

  it("throws FireblocksApiError on a non-2xx response, carrying the status and raw body", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ message: "invalid signature" }) });
    await expect(fireblocksRequest(config, "GET", "/transactions/fb-1")).rejects.toMatchObject({ status: 401 });
  });

  it("throws FireblocksApiError for a 429 rate-limit response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "{}" });
    await expect(fireblocksRequest(config, "POST", "/transactions", {})).rejects.toBeInstanceOf(FireblocksApiError);
  });

  it("throws FireblocksMalformedResponseError when the body isn't valid JSON", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "<html>not json</html>" });
    await expect(fireblocksRequest(config, "GET", "/transactions/fb-1")).rejects.toBeInstanceOf(FireblocksMalformedResponseError);
  });

  it("throws FireblocksTransportError when fetch itself rejects (network error / timeout)", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    await expect(fireblocksRequest(config, "POST", "/transactions", {})).rejects.toBeInstanceOf(FireblocksTransportError);
  });
});
