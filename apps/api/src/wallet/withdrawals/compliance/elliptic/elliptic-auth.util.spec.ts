import * as crypto from "crypto";
import { signEllipticRequest } from "./elliptic-auth.util";

describe("signEllipticRequest", () => {
  const apiSecretBase64 = Buffer.from("test-secret-bytes").toString("base64");

  function expectedSignature(timestampMs: string, method: string, path: string, payload: string): string {
    const hmac = crypto.createHmac("sha256", Buffer.from(apiSecretBase64, "base64"));
    hmac.update(`${timestampMs}${method}${path.toLowerCase()}${payload}`);
    return hmac.digest("base64");
  }

  it("includes the raw api key verbatim in x-access-key", () => {
    const headers = signEllipticRequest({ apiKey: "my-api-key", apiSecretBase64, method: "GET", path: "/v2/wallet/abc", body: undefined });
    expect(headers["x-access-key"]).toBe("my-api-key");
  });

  it("uses the current time in milliseconds as x-access-timestamp", () => {
    const before = Date.now();
    const headers = signEllipticRequest({ apiKey: "k", apiSecretBase64, method: "GET", path: "/v2/wallet/abc" });
    const after = Date.now();
    const ts = Number(headers["x-access-timestamp"]);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("produces a signature matching HMAC-SHA256(secret, timestamp+METHOD+lowercasePath+'{}') for a bodyless GET", () => {
    const headers = signEllipticRequest({ apiKey: "k", apiSecretBase64, method: "GET", path: "/v2/Wallet/ABC-123" });
    const expected = expectedSignature(headers["x-access-timestamp"], "GET", "/v2/wallet/abc-123", "{}");
    expect(headers["x-access-sign"]).toBe(expected);
  });

  it("produces a signature that incorporates the JSON-stringified body for a POST", () => {
    const body = { subject: { asset: "holistic", blockchain: "holistic", type: "address", hash: "0xabc" }, type: "wallet_exposure" };
    const headers = signEllipticRequest({ apiKey: "k", apiSecretBase64, method: "POST", path: "/v2/wallet", body });
    const expected = expectedSignature(headers["x-access-timestamp"], "POST", "/v2/wallet", JSON.stringify(body));
    expect(headers["x-access-sign"]).toBe(expected);
  });

  it("lowercases the path but does not alter the payload's casing", () => {
    const body = { Foo: "Bar" };
    const headers = signEllipticRequest({ apiKey: "k", apiSecretBase64, method: "POST", path: "/V2/WALLET", body });
    const expected = expectedSignature(headers["x-access-timestamp"], "POST", "/v2/wallet", JSON.stringify(body));
    expect(headers["x-access-sign"]).toBe(expected);
  });

  it("produces a different signature for a different secret, given identical inputs", () => {
    const otherSecret = Buffer.from("a-completely-different-secret").toString("base64");
    const a = signEllipticRequest({ apiKey: "k", apiSecretBase64, method: "GET", path: "/v2/wallet/abc" });
    const hmac = crypto.createHmac("sha256", Buffer.from(otherSecret, "base64"));
    hmac.update(`${a["x-access-timestamp"]}GET/v2/wallet/abc{}`);
    expect(hmac.digest("base64")).not.toBe(a["x-access-sign"]);
  });
});
