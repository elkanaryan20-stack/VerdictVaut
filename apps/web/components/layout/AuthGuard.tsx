"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "../../lib/auth/auth-context";

/**
 * Client-side gate for the /wallet route tree. The real security
 * boundary is the backend's own JwtAuthGuard on every wallet endpoint —
 * this exists purely so an unauthenticated visitor is redirected to
 * /login instead of seeing an empty/error wallet shell, and so no
 * wallet data-fetching hook ever fires before we know there's a session
 * to fetch it for.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
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
          <p className="text-sm text-white/50">Loading your wallet…</p>
        </div>
      </div>
    );
  }

  if (status === "unauthenticated") {
    // Redirect effect above is already in flight — render nothing rather
    // than a flash of protected UI.
    return null;
  }

  return <>{children}</>;
}
