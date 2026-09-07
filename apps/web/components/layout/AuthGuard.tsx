"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth, CurrentUser } from "../../lib/auth/auth-context";

export interface AuthGuardProps {
  children: React.ReactNode;
  /**
   * When given, only these roles may see `children` — anyone else
   * (including an authenticated user with the wrong role) sees an
   * in-place "restricted" message instead of a redirect. This is a UX
   * convenience only: every restricted-operations endpoint this gates
   * re-checks the role itself server-side (RolesGuard), so hiding a link
   * here never IS the security boundary, it just avoids showing a page
   * that would only 403 anyway.
   */
  allow?: Array<CurrentUser["role"]>;
}

/**
 * Client-side gate for authenticated route trees (/wallet, /portfolio,
 * /account, /settings, /activity, /admin). The real security boundary is
 * the backend's own JwtAuthGuard (and, for /admin, RolesGuard) on every
 * endpoint — this exists purely so an unauthenticated visitor is
 * redirected to /login instead of seeing an empty/error shell, and so no
 * data-fetching hook ever fires before we know there's a session (and,
 * where `allow` is set, a permitted role) to fetch it for.
 */
export function AuthGuard({ children, allow }: AuthGuardProps) {
  const { status, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-vault-gold border-t-transparent" aria-hidden="true" />
          <p className="text-sm text-white/50">Loading…</p>
        </div>
      </div>
    );
  }

  if (status === "unauthenticated") {
    // Redirect effect above is already in flight — render nothing rather
    // than a flash of protected UI.
    return null;
  }

  if (allow && user && !allow.includes(user.role)) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-sm text-center">
          <h1 className="font-display text-lg font-semibold text-white">Restricted area</h1>
          <p className="mt-2 text-sm text-white/50">Your account doesn&apos;t have access to this section of VerdictVaut.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
