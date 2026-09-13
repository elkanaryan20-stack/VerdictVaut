"use client";

import { useState } from "react";
import { ApiError } from "../../lib/api-client";
import { useAuth } from "../../lib/auth/auth-context";

type SendState = "idle" | "sending" | "sent" | "rate-limited" | "error";

/**
 * Phase 21 — the always-reachable "verification-related UX" a
 * PENDING_VERIFICATION user needs: rendered by AuthGuard above every
 * authenticated route's own content (never blocking it — reads and
 * navigation still work exactly as before; the backend's own
 * ActiveUserGuard/OrdersService/WithdrawalsService checks are what
 * actually stop a financial mutation, not anything here).
 *
 * Deliberately no email-address input (the backend endpoint has none —
 * see AuthService.resendVerificationEmail's own docblock) and no
 * automatic resend on mount — only an explicit click ever calls the API,
 * and the button disables itself after one send until the user
 * navigates or reloads, so a slow double-click can't fire it twice.
 */
export function PendingVerificationBanner() {
  const { resendVerificationEmail } = useAuth();
  const [state, setState] = useState<SendState>("idle");

  async function handleResend() {
    setState("sending");
    try {
      await resendVerificationEmail();
      setState("sent");
    } catch (err) {
      if (err instanceof ApiError && err.isRateLimited) {
        setState("rate-limited");
      } else {
        // The backend never returns a provider-specific or secret-bearing
        // error for this endpoint (see docs/email-delivery.md's failure
        // semantics) — this generic message is not hiding anything, it's
        // simply all there is to say.
        setState("error");
      }
    }
  }

  const canResend = state === "idle" || state === "error" || state === "rate-limited";

  return (
    <div
      role="status"
      className="mb-4 flex flex-col gap-3 rounded-lg border border-vault-gold/30 bg-vault-gold/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div>
        <p className="font-medium text-white">Verify your email to unlock trading, withdrawals, and deposits.</p>
        {state === "sent" && <p className="mt-0.5 text-white/60">A new verification email is on its way — check your inbox.</p>}
        {state === "rate-limited" && <p className="mt-0.5 text-white/60">Too many requests — please wait a moment before trying again.</p>}
        {state === "error" && <p className="mt-0.5 text-white/60">Couldn&apos;t send a new verification email. Please try again.</p>}
      </div>
      <button
        type="button"
        onClick={handleResend}
        disabled={!canResend}
        aria-busy={state === "sending" || undefined}
        className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-vault-gold/40 px-3 text-xs font-medium text-vault-gold transition-colors hover:bg-vault-gold/10 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-vault-gold"
      >
        {state === "sending" ? "Sending…" : state === "sent" ? "Sent" : "Resend verification email"}
      </button>
    </div>
  );
}
