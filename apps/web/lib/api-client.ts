import { clearTokens, getAccessToken, getRefreshToken, setTokens } from "./auth/token-storage";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
}

async function extractErrorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  if (!body) return response.statusText || "Request failed";
  if (typeof body.message === "string") return body.message;
  if (Array.isArray(body.message)) return body.message.join(", ");
  return response.statusText || "Request failed";
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
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
  });

  if (response.status === 401 && !skipAuth && !_isRetry && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return apiFetch<T>(path, { ...options, _isRetry: true });
    }
  }

  if (!response.ok) {
    const message = await extractErrorMessage(response);
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
