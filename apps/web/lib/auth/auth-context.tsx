"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../api-client";
import { clearTokens, getAccessToken, getRefreshToken, setTokens, TokenPair } from "./token-storage";

export interface CurrentUser {
  id: string;
  email: string;
  role: "USER" | "RISK_OPS" | "ADMIN" | "SUPER_ADMIN";
  status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED";
  createdAt: string;
}

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUser | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Phase 21 — re-fetches GET /users/me and updates the cached user.
   * Called after a successful /verify-email submission so a session
   * already open in this browser reflects the new ACTIVE status
   * immediately, with no forced logout/login cycle (the existing access
   * token remains valid and usable throughout — see AuthService's own
   * docblock on why status is never encoded in the JWT itself).
   */
  refreshUser: () => Promise<void>;
  /**
   * Phase 21 — thin wrapper over the existing authenticated
   * POST /auth/resend-verification-email (Phase 20). No email-address
   * argument by design: the endpoint only ever acts on the caller's own
   * account, identified by the bearer token apiFetch already attaches.
   */
  resendVerificationEmail: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<CurrentUser | null>(null);

  const loadCurrentUser = useCallback(async () => {
    if (!getAccessToken()) {
      setStatus("unauthenticated");
      setUser(null);
      return;
    }
    try {
      const me = await apiFetch<CurrentUser>("/users/me");
      setUser(me);
      setStatus("authenticated");
    } catch {
      clearTokens();
      setUser(null);
      setStatus("unauthenticated");
    }
  }, []);

  useEffect(() => {
    loadCurrentUser();
  }, [loadCurrentUser]);

  const login = useCallback(
    async (email: string, password: string) => {
      const tokens = await apiFetch<TokenPair>("/auth/login", {
        method: "POST",
        skipAuth: true,
        body: JSON.stringify({ email, password }),
      });
      setTokens(tokens);
      await loadCurrentUser();
    },
    [loadCurrentUser],
  );

  const register = useCallback(
    async (email: string, password: string) => {
      const tokens = await apiFetch<TokenPair>("/auth/register", {
        method: "POST",
        skipAuth: true,
        body: JSON.stringify({ email, password }),
      });
      setTokens(tokens);
      await loadCurrentUser();
    },
    [loadCurrentUser],
  );

  const logout = useCallback(async () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) {
      // Best-effort server-side revocation of this refresh token — the
      // client-side sign-out below happens regardless of whether this
      // succeeds, since the user's own browser state is what actually
      // gates access to the wallet UI.
      await apiFetch("/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) }).catch(() => undefined);
    }
    clearTokens();
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const refreshUser = useCallback(async () => {
    await loadCurrentUser();
  }, [loadCurrentUser]);

  const resendVerificationEmail = useCallback(async () => {
    await apiFetch("/auth/resend-verification-email", { method: "POST" });
  }, []);

  const value = useMemo(
    () => ({ status, user, login, register, logout, refreshUser, resendVerificationEmail }),
    [status, user, login, register, logout, refreshUser, resendVerificationEmail],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
