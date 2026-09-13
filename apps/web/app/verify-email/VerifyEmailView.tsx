"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { ApiError, apiFetch } from "../../lib/api-client";
import { useAuth } from "../../lib/auth/auth-context";

type ViewState = "missing-token" | "verifying" | "success" | "invalid" | "network-error";

/**
 * Never logs, persists, or forwards the raw token anywhere beyond this
 * one POST body — no console.log, no analytics call (this app has none
 * to begin with), no localStorage/sessionStorage write. Read fresh from
 * the URL on each render via useSearchParams(); once the verification
 * attempt finishes (success OR failure), router.replace() strips the
 * token from the visible URL/history so it doesn't linger there longer
 * than the one request that needed it.
 *
 * The backend deliberately returns the SAME generic error for an
 * invalid, expired, or already-used token (see AuthService.verifyEmail's
 * own docblock: "no response here should let a caller distinguish
 * those") — this view respects that and shows one identical message for
 * all three, rather than trying to guess/re-derive a distinction the
 * backend intentionally does not expose.
 */
export function VerifyEmailView() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { status: authStatus, refreshUser } = useAuth();
  const [view, setView] = useState<ViewState>("verifying");
  const attempted = useRef(false);

  // Captured ONCE, from whatever the URL held on first render — never
  // re-derived from searchParams afterward, since attemptVerification's
  // own `finally` block deliberately strips the token from the URL once
  // the first attempt finishes. Without this, a "Try again" click after
  // a network error would silently find no token left to resubmit.
  const [token] = useState(() => searchParams.get("token"));

  const attemptVerification = useCallback(
    async (rawToken: string) => {
      setView("verifying");
      try {
        await apiFetch<{ status: string }>("/auth/verify-email", {
          method: "POST",
          skipAuth: true,
          body: JSON.stringify({ token: rawToken }),
        });
        setView("success");
        // Best-effort — updates an already-open session in this browser
        // to reflect ACTIVE immediately. If there is no session here
        // (a different device/browser than the one that registered),
        // this simply resolves to "unauthenticated", which is already
        // this hook's normal, harmless behavior with no token stored.
        await refreshUser().catch(() => undefined);
      } catch (err) {
        setView(err instanceof ApiError ? "invalid" : "network-error");
      } finally {
        // Never leave the raw token sitting in the address bar/history
        // longer than the one request that needed it.
        router.replace("/verify-email");
      }
    },
    [refreshUser, router],
  );

  useEffect(() => {
    if (attempted.current) return; // StrictMode/re-render safety — a token is single-use, never submit it twice
    attempted.current = true;

    if (!token) {
      setView("missing-token");
      return;
    }
    void attemptVerification(token);
    // Intentionally runs once on mount with whatever token was present
    // then — see attempted.current above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-vault-gold" aria-hidden="true" />
          <span className="font-display text-sm font-semibold uppercase tracking-[0.3em] text-white">VerdictVaut</span>
        </div>

        <div className="rounded-xl border border-vault-border bg-vault-surface p-6 text-center">
          {view === "verifying" && (
            <>
              <span className="mx-auto mb-4 block h-8 w-8 animate-spin rounded-full border-2 border-vault-gold border-t-transparent" aria-hidden="true" />
              <h1 className="font-display text-lg font-semibold text-white">Verifying your email…</h1>
            </>
          )}

          {view === "success" && (
            <>
              <h1 className="font-display text-lg font-semibold text-white">Email verified</h1>
              <p className="mt-2 text-sm text-white/50">Your account is now active. You&apos;re ready to trade, deposit, and withdraw.</p>
              {/* Fixed internal routes only — never derived from the token or any query parameter, so this can never become an open redirect. */}
              <Button className="mt-6 w-full" onClick={() => router.replace(authStatus === "authenticated" ? "/wallet" : "/login")}>
                {authStatus === "authenticated" ? "Continue to your wallet" : "Continue to sign in"}
              </Button>
            </>
          )}

          {view === "invalid" && (
            <>
              <h1 className="font-display text-lg font-semibold text-white">This link is invalid or has expired</h1>
              <p className="mt-2 text-sm text-white/50">
                Verification links expire after 24 hours and can only be used once. Sign in to request a new one.
              </p>
              <Link href="/login">
                <Button className="mt-6 w-full">Continue to sign in</Button>
              </Link>
            </>
          )}

          {view === "missing-token" && (
            <>
              <h1 className="font-display text-lg font-semibold text-white">Missing verification link</h1>
              <p className="mt-2 text-sm text-white/50">This page needs the verification link from your email — please open it directly from there.</p>
              <Link href="/login">
                <Button className="mt-6 w-full">Continue to sign in</Button>
              </Link>
            </>
          )}

          {view === "network-error" && (
            <>
              <h1 className="font-display text-lg font-semibold text-white">Something went wrong</h1>
              <p className="mt-2 text-sm text-white/50">We couldn&apos;t reach VerdictVaut to verify your email. Please try again.</p>
              <Button
                className="mt-6 w-full"
                onClick={() => {
                  // Re-runs with the SAME token already held in memory
                  // from the initial page load — never re-reads it from
                  // the URL (already stripped by the first attempt) and
                  // never asks the user to click the email link again.
                  if (token) void attemptVerification(token);
                }}
              >
                Try again
              </Button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
