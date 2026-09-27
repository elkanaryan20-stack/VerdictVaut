import { act, render, screen, waitFor } from "@testing-library/react";
import { SESSION_EXPIRED_EVENT } from "../lib/api-client";
import { AuthProvider, useAuth } from "../lib/auth/auth-context";
import { setTokens } from "../lib/auth/token-storage";

/**
 * Phase 36 — a previously valid session must not be assumed to remain
 * authorized: once any API call learns the backend rejected the session,
 * the whole app drops to "unauthenticated" (AuthGuard then redirects to
 * /login), instead of keeping stale signed-in UI that only shows 401s.
 */
function StatusProbe() {
  const { status, user } = useAuth();
  return (
    <p>
      status:{status} user:{user?.email ?? "none"}
    </p>
  );
}

describe("AuthProvider session expiry", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "",
      json: async () => ({ id: "u-1", email: "a@b.c", role: "USER", status: "ACTIVE", createdAt: "2026-09-27T00:00:00.000Z" }),
    } as Response);
    setTokens({ accessToken: "access", refreshToken: "refresh" });
  });

  it("drops an authenticated session to unauthenticated when the session-expired signal fires", async () => {
    render(
      <AuthProvider>
        <StatusProbe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText(/status:authenticated user:a@b.c/)).toBeInTheDocument());

    act(() => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    });

    expect(screen.getByText(/status:unauthenticated user:none/)).toBeInTheDocument();
  });
});
