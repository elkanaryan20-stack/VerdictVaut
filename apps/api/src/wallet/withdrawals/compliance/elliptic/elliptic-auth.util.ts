import * as crypto from "crypto";

/**
 * Elliptic AML API HMAC-SHA256 request signing — VERIFIED against
 * https://developers.elliptic.co/docs/authentication (Phase 14B research
 * pass), including its own worked examples:
 *   POST /v2/analyses  -> 65mQHB2o95lL3I+N/bZYwDC9p2YvNwsVDnXr8u72hUk=
 *   GET  /v2/customers -> cN9fRUqeT7UnwwpkBZaNmnwxKAPHkhytdXelfUVvxMI=
 *
 * Signature = base64(HMAC-SHA256(base64-decode(secret),
 *   `${timestampMs}${METHOD_UPPER}${path.toLowerCase()}${payload}`))
 * where `payload` is the JSON-stringified request body, or the literal
 * string "{}" when there is no body — concatenated with NO separators.
 */
export interface EllipticSignedHeaders {
  "x-access-key": string;
  "x-access-sign": string;
  "x-access-timestamp": string;
}

export function signEllipticRequest(params: { apiKey: string; apiSecretBase64: string; method: "GET" | "POST"; path: string; body?: unknown }): EllipticSignedHeaders {
  const timestampMs = Date.now().toString();
  const payload = params.body !== undefined ? JSON.stringify(params.body) : "{}";
  const requestText = `${timestampMs}${params.method.toUpperCase()}${params.path.toLowerCase()}${payload}`;

  const secretBytes = Buffer.from(params.apiSecretBase64, "base64");
  const signature = crypto.createHmac("sha256", secretBytes).update(requestText).digest("base64");

  return {
    "x-access-key": params.apiKey,
    "x-access-sign": signature,
    "x-access-timestamp": timestampMs,
  };
}
