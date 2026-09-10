import { signFireblocksRequestJwt } from "./fireblocks-jwt.util";

export interface FireblocksHttpConfig {
  apiBaseUrl: string;
  apiKey: string;
  privateKeyPem: string;
  timeoutMs: number;
}

/** A response Fireblocks returned, but with a non-2xx status — VERIFIED that 429 exists (rate limiting docs); the exact JSON error-body shape was NOT verified, so `body` is passed through as raw unknown rather than parsed into an assumed shape. */
export class FireblocksApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Fireblocks API responded ${status}`);
    this.name = "FireblocksApiError";
  }
}

/** The response body did not parse as JSON at all — an explicitly-handled failure mode (Phase 14B section 10: "malformed provider response"), never silently treated as an empty/successful result. */
export class FireblocksMalformedResponseError extends Error {
  constructor(status: number) {
    super(`Fireblocks response (status ${status}) was not valid JSON`);
    this.name = "FireblocksMalformedResponseError";
  }
}

/** A distinct class specifically for "the request never got a response at all" (timeout/network error) — deliberately never conflated with FireblocksApiError, since the caller's safe handling differs (this is the case that can be genuinely ambiguous about whether Fireblocks received the request). */
export class FireblocksTransportError extends Error {
  constructor(cause: unknown) {
    super(`Fireblocks request failed before any response was received: ${(cause as Error).message ?? String(cause)}`);
    this.name = "FireblocksTransportError";
  }
}

/**
 * One signed Fireblocks REST call. Auth mechanism (X-API-Key header +
 * `Authorization: Bearer <RS256 JWT>`) VERIFIED against
 * https://developers.fireblocks.com/reference/signing-a-request-jwt-structure.
 * The exact literal request paths used by callers of this function
 * (e.g. "/transactions") are NOT independently rendered/confirmed from
 * a primary source in the Phase 14B research pass — see
 * fireblocks-custody.adapter.ts's own docblock for the full honesty
 * statement on that gap. This function itself makes no path assumptions.
 *
 * Deliberately does NOT wrap itself in automatic retry — a caller
 * mutating state (e.g. creating a transaction) must decide for itself
 * whether a given failure is safe to retry; blindly retrying inside
 * this shared helper would apply the same policy to both read-only
 * status lookups (safe to retry) and transaction creation (not
 * automatically safe) without the context to tell them apart.
 */
export async function fireblocksRequest<T>(config: FireblocksHttpConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const rawBody = body !== undefined ? JSON.stringify(body) : "";
  const jwt = signFireblocksRequestJwt({ uri: path, apiKey: config.apiKey, privateKeyPem: config.privateKeyPem, rawBody });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers: {
        "X-API-Key": config.apiKey,
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: rawBody || undefined,
      signal: controller.signal,
    });
  } catch (error) {
    throw new FireblocksTransportError(error);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new FireblocksMalformedResponseError(response.status);
  }

  if (!response.ok) {
    throw new FireblocksApiError(response.status, parsed);
  }
  return parsed as T;
}
