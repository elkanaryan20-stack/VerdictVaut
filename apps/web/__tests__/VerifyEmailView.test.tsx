import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VerifyEmailView } from "../app/verify-email/VerifyEmailView";
import { ApiError, apiFetch } from "../lib/api-client";
import { useAuth } from "../lib/auth/auth-context";

jest.mock("../lib/api-client", () => ({
  ...jest.requireActual("../lib/api-client"),
  apiFetch: jest.fn(),
}));
jest.mock("../lib/auth/auth-context", () => ({ useAuth: jest.fn() }));

const replace = jest.fn();
let searchParamsValue: string | null = "a-real-raw-token-value";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => ({ get: (key: string) => (key === "token" ? searchParamsValue : null) }),
}));

const mockedApiFetch = apiFetch as jest.Mock;
const mockedUseAuth = useAuth as jest.Mock;

describe("VerifyEmailView", () => {
  const refreshUser = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    replace.mockClear();
    mockedApiFetch.mockReset();
    refreshUser.mockClear();
    mockedUseAuth.mockReturnValue({ status: "authenticated", refreshUser });
    searchParamsValue = "a-real-raw-token-value";
  });

  it("shows a loading state immediately, before the request resolves", () => {
    mockedApiFetch.mockReturnValue(new Promise(() => undefined)); // never resolves within this test
    render(<VerifyEmailView />);
    expect(screen.getByText(/verifying your email/i)).toBeInTheDocument();
  });

  it("missing token: shows a clear message and never calls the API", () => {
    searchParamsValue = null;
    render(<VerifyEmailView />);
    expect(screen.getByText(/missing verification link/i)).toBeInTheDocument();
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it("valid token: calls POST /auth/verify-email with the token, shows success, refreshes the cached user, and strips the token from the URL", async () => {
    mockedApiFetch.mockResolvedValue({ status: "ACTIVE" });
    render(<VerifyEmailView />);

    expect(await screen.findByText(/email verified/i)).toBeInTheDocument();
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/auth/verify-email",
      expect.objectContaining({ method: "POST", skipAuth: true, body: JSON.stringify({ token: "a-real-raw-token-value" }) }),
    );
    expect(refreshUser).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/verify-email");
  });

  it("invalid/expired/already-used token: the backend returns one generic error, and this view shows one generic message — never tries to distinguish them", async () => {
    mockedApiFetch.mockRejectedValue(new ApiError(401, "Invalid or expired verification token"));
    render(<VerifyEmailView />);
    expect(await screen.findByText(/this link is invalid or has expired/i)).toBeInTheDocument();
    expect(refreshUser).not.toHaveBeenCalled();
  });

  it("network/server failure: shows a distinct message with a manual retry — never an automatic retry loop", async () => {
    mockedApiFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<VerifyEmailView />);
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(mockedApiFetch).toHaveBeenCalledTimes(1); // no automatic retry

    mockedApiFetch.mockResolvedValueOnce({ status: "ACTIVE" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByText(/email verified/i)).toBeInTheDocument();
    expect(mockedApiFetch).toHaveBeenCalledTimes(2);
  });

  it("success screen routes to /wallet when a session is already open in this browser", async () => {
    mockedApiFetch.mockResolvedValue({ status: "ACTIVE" });
    mockedUseAuth.mockReturnValue({ status: "authenticated", refreshUser });
    const user = userEvent.setup();
    render(<VerifyEmailView />);
    await user.click(await screen.findByRole("button", { name: /continue to your wallet/i }));
    expect(replace).toHaveBeenLastCalledWith("/wallet");
  });

  it("success screen routes to /login when there is no session in this browser (a different device than the one that registered)", async () => {
    mockedApiFetch.mockResolvedValue({ status: "ACTIVE" });
    mockedUseAuth.mockReturnValue({ status: "unauthenticated", refreshUser });
    const user = userEvent.setup();
    render(<VerifyEmailView />);
    await user.click(await screen.findByRole("button", { name: /continue to sign in/i }));
    expect(replace).toHaveBeenLastCalledWith("/login");
  });

  it("never renders the raw token anywhere on the page", async () => {
    mockedApiFetch.mockResolvedValue({ status: "ACTIVE" });
    render(<VerifyEmailView />);
    await screen.findByText(/email verified/i);
    expect(screen.queryByText("a-real-raw-token-value")).not.toBeInTheDocument();
  });

  it("never logs the raw token to the console", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockedApiFetch.mockResolvedValue({ status: "ACTIVE" });
    render(<VerifyEmailView />);
    await screen.findByText(/email verified/i);
    expect(JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls])).not.toContain("a-real-raw-token-value");
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
