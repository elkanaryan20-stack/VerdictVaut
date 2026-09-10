import * as crypto from "crypto";
import { computeFireblocksBodyHash, signFireblocksRequestJwt } from "./fireblocks-jwt.util";

function generateTestKeyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function decodeJwt(token: string) {
  const [headerB64, payloadB64, signatureB64] = token.split(".");
  const pad = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  const header = JSON.parse(Buffer.from(pad(headerB64), "base64").toString("utf8"));
  const payload = JSON.parse(Buffer.from(pad(payloadB64), "base64").toString("utf8"));
  return { header, payload, signingInput: `${headerB64}.${payloadB64}`, signature: Buffer.from(pad(signatureB64), "base64") };
}

describe("signFireblocksRequestJwt", () => {
  it("produces a JWT whose signature genuinely verifies against the corresponding public key (RS256)", () => {
    const { privateKey, publicKey } = generateTestKeyPair();
    const token = signFireblocksRequestJwt({ uri: "/v1/transactions", apiKey: "test-api-key", privateKeyPem: privateKey, rawBody: '{"assetId":"BTC_TEST"}' });

    const { header, payload, signingInput, signature } = decodeJwt(token);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(crypto.verify("RSA-SHA256", Buffer.from(signingInput, "utf8"), publicKey, signature)).toBe(true);
    expect(payload.sub).toBe("test-api-key");
    expect(payload.uri).toBe("/v1/transactions");
  });

  it("sets bodyHash to the SHA-256 hex digest of the exact raw body string", () => {
    const { privateKey } = generateTestKeyPair();
    const rawBody = '{"assetId":"BTC_TEST","amount":"0.001"}';
    const token = signFireblocksRequestJwt({ uri: "/v1/transactions", apiKey: "k", privateKeyPem: privateKey, rawBody });

    const { payload } = decodeJwt(token);
    expect(payload.bodyHash).toBe(computeFireblocksBodyHash(rawBody));
  });

  it("hashes the empty string for a bodyless (GET) request", () => {
    const { privateKey } = generateTestKeyPair();
    const token = signFireblocksRequestJwt({ uri: "/v1/transactions/abc", apiKey: "k", privateKeyPem: privateKey, rawBody: "" });
    const { payload } = decodeJwt(token);
    expect(payload.bodyHash).toBe(crypto.createHash("sha256").update("").digest("hex"));
  });

  it("sets exp strictly less than iat + 30 seconds, per Fireblocks' own documented requirement", () => {
    const { privateKey } = generateTestKeyPair();
    const token = signFireblocksRequestJwt({ uri: "/v1/transactions", apiKey: "k", privateKeyPem: privateKey, rawBody: "" });
    const { payload } = decodeJwt(token);
    expect(payload.exp - payload.iat).toBeLessThan(30);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("generates a fresh, distinct nonce on every call — a token can never be replayed as-is for a different request", () => {
    const { privateKey } = generateTestKeyPair();
    const first = decodeJwt(signFireblocksRequestJwt({ uri: "/v1/transactions", apiKey: "k", privateKeyPem: privateKey, rawBody: "" }));
    const second = decodeJwt(signFireblocksRequestJwt({ uri: "/v1/transactions", apiKey: "k", privateKeyPem: privateKey, rawBody: "" }));
    expect(first.payload.nonce).not.toBe(second.payload.nonce);
  });

  it("fails verification against a DIFFERENT key pair — proves the signature is genuinely bound to the signing key, not just well-formed", () => {
    const { privateKey } = generateTestKeyPair();
    const { publicKey: wrongPublicKey } = generateTestKeyPair();
    const token = signFireblocksRequestJwt({ uri: "/v1/transactions", apiKey: "k", privateKeyPem: privateKey, rawBody: "" });
    const { signingInput, signature } = decodeJwt(token);
    expect(crypto.verify("RSA-SHA256", Buffer.from(signingInput, "utf8"), wrongPublicKey, signature)).toBe(false);
  });
});
