import { clearTokens, getAccessToken, getRefreshToken, setTokens } from "./auth/token-storage";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Phase 36 — dispatched on `window` when the backend definitively rejects
 * this browser's session (the access token was refused and no refresh
 * could replace it). AuthProvider listens and drops to "unauthenticated",
 * so protected pages redirect to /login instead of sitting on a screen
 * full of 401 errors while still believing the user is signed in.
 */
export const SESSION_EXPIRED_EVENT = "verdictvaut:session-expired";

/** status 0 = the request never got an HTTP response (offline, DNS, CORS, connection reset). */
export const NETWORK_ERROR_STATUS = 0;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The backend's per-request id (AllExceptionsFilter's `requestId`), for support/log correlation. */
    public requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  get isServerError(): boolean {
    return this.status >= 500;
  }

  get isNetworkError(): boolean {
    return this.status === NETWORK_ERROR_STATUS;
  }
}

const RATE_LIMITED_MESSAGE = "Too many requests — please wait a moment before trying again.";
// Deliberately never "nothing was submitted": a connection can drop after
// the server already processed a request, so the only honest advice is to
// check the real state before retrying (idempotency keys make a same-form
// retry safe, but the user shouldn't be told it definitely failed).
const NETWORK_ERROR_MESSAGE = "Couldn't reach VerdictVaut. If you were submitting something, check whether it went through before trying again.";

async function extractErrorDetails(response: Response): Promise<{ message: string; requestId?: string }> {
  const body = await response.json().catch(() => null);
  const requestId = body && typeof body.requestId === "string" ? body.requestId : undefined;
  if (response.status === 429) return { message: RATE_LIMITED_MESSAGE, requestId };
  if (!body) return { message: response.statusText || "Request failed", requestId };
  if (typeof body.message === "string") return { message: body.message, requestId };
  if (Array.isArray(body.message)) return { message: body.message.join(", "), requestId };
  return { message: response.statusText || "Request failed", requestId };
}

function signalSessionExpired(): void {
  clearTokens();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }
}

// Concurrent requests that all hit a 401 at once must trigger exactly one
// refresh call, not one per request — every caller awaits this same
// in-flight promise instead of racing the backend's refresh-token
// rotation (which revokes the presented token on use, so a second
// simultaneous refresh call would just fail).
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return false;

      try {
        const response = await fetch(`${API_URL}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!response.ok) {
          clearTokens();
          return false;
        }
        const tokens = await response.json();
        setTokens(tokens);
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export interface ApiFetchOptions extends RequestInit {
  /** Skips attaching an Authorization header — for the public auth endpoints themselves. */
  skipAuth?: boolean;
  /** Internal — set when this call is itself a post-refresh retry, to stop an infinite loop. */
  _isRetry?: boolean;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { skipAuth, _isRetry, headers, ...init } = options;

  const accessToken = skipAuth ? null : getAccessToken();
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...headers,
      },
    });
  } catch {
    throw new ApiError(NETWORK_ERROR_STATUS, NETWORK_ERROR_MESSAGE);
  }

  if (response.status === 401 && !skipAuth && !_isRetry && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiFetch<T>(path, { ...options, _isRetry: true });
    }
  }

  if (!response.ok) {
    const { message, requestId } = await extractErrorDetails(response);
    // A 401 on an authenticated call that survived the refresh attempt
    // above means the backend no longer accepts this session at all
    // (expired, revoked, password changed elsewhere) — never keep acting
    // as if the user were still signed in.
    if (response.status === 401 && accessToken) {
      signalSessionExpired();
    }
    throw new ApiError(response.status, message, requestId);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
