import { signEllipticRequest } from "./elliptic-auth.util";

export interface EllipticHttpConfig {
  apiBaseUrl: string;
  apiKey: string;
  apiSecretBase64: string;
  timeoutMs: number;
}

/** A response Elliptic returned, but with a non-2xx (or 207 partial-error) status. The exact error-body shape was not verified, so `body` is passed through as raw unknown rather than parsed into an assumed shape. */
export class EllipticApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Elliptic API responded ${status}`);
    this.name = "EllipticApiError";
  }
}

/** The response body did not parse as JSON at all — an explicitly-handled failure mode, never silently treated as an empty/successful result. */
export class EllipticMalformedResponseError extends Error {
  constructor(status: number) {
    super(`Elliptic response (status ${status}) was not valid JSON`);
    this.name = "EllipticMalformedResponseError";
  }
}

/** The request never received a response at all (timeout/network error) — kept distinct from EllipticApiError since a caller cannot tell whether Elliptic actually received/processed the request. */
export class EllipticTransportError extends Error {
  constructor(cause: unknown) {
    super(`Elliptic request failed before any response was received: ${(cause as Error).message ?? String(cause)}`);
    this.name = "EllipticTransportError";
  }
}

/**
 * One signed Elliptic AML API REST call. Auth scheme VERIFIED against
 * https://developers.elliptic.co/docs/authentication (Phase 14B research
 * pass) — see elliptic-auth.util.ts. Base path VERIFIED as
 * https://aml-api.elliptic.co/v2 (Phase 14B research pass). Deliberately
 * not auto-retried, for the same reason fireblocksRequest() isn't: a
 * caller submitting a new analysis (a mutation, even if idempotency
 * there is itself unverified — see EllipticAddressRiskGate's docblock)
 * must decide for itself whether a failure is safe to retry.
 */
export async function ellipticRequest<T>(config: EllipticHttpConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers = signEllipticRequest({ apiKey: config.apiKey, apiSecretBase64: config.apiSecretBase64, method, path, body });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${config.apiBaseUrl}${path}`, {
      method,
      headers: { ...headers, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (error) {
    throw new EllipticTransportError(error);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new EllipticMalformedResponseError(response.status);
  }

  if (!response.ok) {
    throw new EllipticApiError(response.status, parsed);
  }
  return parsed as T;
}
