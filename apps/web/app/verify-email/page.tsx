import { Suspense } from "react";
import { VerifyEmailView } from "./VerifyEmailView";

/**
 * Public route — POST /auth/verify-email carries no auth guard on the
 * backend (the token itself is the credential, same shape as a
 * password-reset link — see AuthController's own comment), so this page
 * must work for a visitor with no session in this browser at all, e.g.
 * opening the link on a different device than the one they registered
 * from. Wrapped in Suspense because VerifyEmailView reads
 * useSearchParams(), which Next.js requires a Suspense boundary for.
 */
export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center px-4">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-vault-gold border-t-transparent" aria-hidden="true" />
        </main>
      }
    >
      <VerifyEmailView />
    </Suspense>
  );
}
