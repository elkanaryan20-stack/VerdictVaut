import * as crypto from "crypto";
import { verifyFireblocksWebhookSignature } from "./fireblocks-webhook-verifier.util";

function generateTestKeyPair() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
}

function sign(body: string, privateKey: string): string {
  return crypto.sign("RSA-SHA512", Buffer.from(body, "utf8"), privateKey).toString("base64");
}

describe("verifyFireblocksWebhookSignature", () => {
  it("accepts a genuinely valid signature over the exact body", () => {
    const { privateKey, publicKey } = generateTestKeyPair();
    const body = JSON.stringify({ type: "TRANSACTION_STATUS_UPDATED", data: { id: "fb-1", status: "COMPLETED" } });
    const signature = sign(body, privateKey);
    expect(verifyFireblocksWebhookSignature(body, signature, publicKey)).toBe(true);
  });

  it("rejects a signature for a body that was tampered with after signing", () => {
    const { privateKey, publicKey } = generateTestKeyPair();
    const originalBody = JSON.stringify({ type: "TRANSACTION_STATUS_UPDATED", data: { id: "fb-1", status: "COMPLETED" } });
    const signature = sign(originalBody, privateKey);
    const tamperedBody = JSON.stringify({ type: "TRANSACTION_STATUS_UPDATED", data: { id: "fb-1", status: "FAILED" } });
    expect(verifyFireblocksWebhookSignature(tamperedBody, signature, publicKey)).toBe(false);
  });

  it("rejects a signature verified against the WRONG public key", () => {
    const { privateKey } = generateTestKeyPair();
    const { publicKey: wrongPublicKey } = generateTestKeyPair();
    const body = "{}";
    const signature = sign(body, privateKey);
    expect(verifyFireblocksWebhookSignature(body, signature, wrongPublicKey)).toBe(false);
  });

  it("returns false (never throws) for a malformed base64 signature", () => {
    const { publicKey } = generateTestKeyPair();
    expect(verifyFireblocksWebhookSignature("{}", "not-valid-base64!!!", publicKey)).toBe(false);
  });

  it("returns false (never throws) for a malformed public key", () => {
    expect(verifyFireblocksWebhookSignature("{}", Buffer.from("sig").toString("base64"), "not-a-real-key")).toBe(false);
  });
});
