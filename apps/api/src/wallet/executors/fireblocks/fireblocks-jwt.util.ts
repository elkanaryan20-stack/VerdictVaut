import * as crypto from "crypto";

// Fireblocks' own documented request-signing scheme — VERIFIED against
// https://developers.fireblocks.com/reference/signing-a-request-jwt-structure
// (Phase 14B research pass): RS256 JWT, claims {uri, nonce, iat, exp,
// sub, bodyHash}, sent as `Authorization: Bearer <jwt>` alongside a
// separate `X-API-Key` header (see fireblocks-http.util.ts). This is a
// direct transcription of a documented, standard JWT construction
// (base64url + RSA sign, both native Node `crypto` capabilities) — not
// an invented scheme.
const MAX_EXPIRY_SECONDS = 30; // Fireblocks' own docs: exp must be < iat + 30s
const EXPIRY_MARGIN_SECONDS = 5; // headroom for clock skew / request latency

function base64url(input: Buffer | string): string {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 of the exact raw request body, hex-encoded — Fireblocks' documented `bodyHash` claim. GET/DELETE with no body hashes the empty string. */
export function computeFireblocksBodyHash(rawBody: string): string {
  return crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
}

export interface FireblocksJwtParams {
  /** The request path Fireblocks expects in the `uri` claim (e.g. "/v1/transactions"). */
  uri: string;
  /** Fireblocks API key — the `sub` claim; not a secret by itself but never logged regardless. */
  apiKey: string;
  /** PEM-encoded RSA private key content — resolved via SecretResolverService, never stored/logged. */
  privateKeyPem: string;
  /** Exact raw request body string that will actually be sent (empty string for GET). */
  rawBody: string;
}

/** Builds and signs one Fireblocks request JWT. A fresh call is required per request — the short expiry and per-request nonce/bodyHash mean a token can't be reused across calls. */
export function signFireblocksRequestJwt(params: FireblocksJwtParams): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = {
    uri: params.uri,
    nonce: crypto.randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + (MAX_EXPIRY_SECONDS - EXPIRY_MARGIN_SECONDS),
    sub: params.apiKey,
    bodyHash: computeFireblocksBodyHash(params.rawBody),
  };
  const header = { alg: "RS256", typ: "JWT" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), params.privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}
