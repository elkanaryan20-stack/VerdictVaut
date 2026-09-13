export interface PostmarkHttpConfig {
  serverToken: string;
  timeoutMs: number;
}

/** A response Postmark returned, but with a non-2xx status (e.g. 401 invalid server token, 422 validation failure such as an unconfirmed sender or inactive/bounced recipient). The exact error-body shape is passed through as raw unknown rather than parsed into an assumed structure beyond the documented `ErrorCode`/`Message` fields every Postmark response carries — see postmark-email.provider.ts for how those two fields specifically are read. */
export class PostmarkApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`Postmark API responded ${status}`);
    this.name = "PostmarkApiError";
  }
}

/** The response body did not parse as JSON at all — an explicitly-handled failure mode, never silently treated as an empty/successful result (same pattern as FireblocksMalformedResponseError/EllipticMalformedResponseError). */
export class PostmarkMalformedResponseError extends Error {
  constructor(status: number) {
    super(`Postmark response (status ${status}) was not valid JSON`);
    this.name = "PostmarkMalformedResponseError";
  }
}

/** The request never received a response at all (timeout/network error) — kept distinct from PostmarkApiError since a caller cannot tell whether Postmark actually received/processed the request, unlike a definite non-2xx response. */
export class PostmarkTransportError extends Error {
  constructor(cause: unknown) {
    super(`Postmark request failed before any response was received: ${(cause as Error).message ?? String(cause)}`);
    this.name = "PostmarkTransportError";
  }
}

/**
 * One call to Postmark's "Send a single email" endpoint. Method, URL,
 * headers, and both the request and success-response field names below
 * are VERIFIED against Postmark's own published API reference
 * (https://postmarkapp.com/developer/api/email-api, fetched this
 * session) — nothing here is invented or guessed:
 *
 *   POST https://api.postmarkapp.com/email
 *   Headers: Content-Type: application/json, Accept: application/json,
 *            X-Postmark-Server-Token: <server token>
 *   Body: { From, To, Subject, HtmlBody?, TextBody?, MessageStream? }
 *     (HtmlBody or TextBody required; MessageStream defaults to
 *     "outbound" when omitted — this function never sets it, leaving
 *     Postmark's own documented default in effect)
 *   Success (200): { To, SubmittedAt, MessageID, ErrorCode: 0, Message }
 *   Failure: non-2xx status (401 for an invalid server token; 422 with
 *     a specific ErrorCode/Message for validation failures such as an
 *     unconfirmed sender signature or an inactive/bounced recipient —
 *     e.g. ErrorCode 406). Every response, success or failure, carries
 *     `ErrorCode`/`Message` — this function does not need to branch on
 *     the numeric ErrorCode itself; a non-2xx HTTP status is already a
 *     sufficient, documented signal that the send did not succeed.
 *
 * Deliberately does NOT retry automatically — mirrors
 * fireblocksRequest()/ellipticRequest()'s own reasoning: sending a
 * duplicate verification email on a blind retry is a caller-level
 * decision (see AuthService's own failure handling), not something a
 * shared HTTP helper should decide unilaterally.
 */
export async function postmarkRequest<T>(config: PostmarkHttpConfig, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": config.serverToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new PostmarkTransportError(error);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new PostmarkMalformedResponseError(response.status);
  }

  if (!response.ok) {
    throw new PostmarkApiError(response.status, parsed);
  }
  return parsed as T;
}
