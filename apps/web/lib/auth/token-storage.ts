/**
 * The backend issues bearer tokens in a JSON response body (see
 * apps/api AuthService) rather than setting its own cookies, so the
 * browser has to hold onto them itself to attach `Authorization` on
 * later requests. localStorage is the pragmatic fit for that shape of
 * API, not a workaround — there is no session cookie to piggyback on.
 *
 * Every function here is SSR-safe (guards on `typeof window`): this
 * module can be imported from code that also runs during a server
 * render pass, where `localStorage` does not exist.
 */
const ACCESS_TOKEN_KEY = "verdictvaut.accessToken";
const REFRESH_TOKEN_KEY = "verdictvaut.refreshToken";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function getAccessToken(): string | null {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setTokens(tokens: TokenPair): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
  window.localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
}

export function clearTokens(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
}
