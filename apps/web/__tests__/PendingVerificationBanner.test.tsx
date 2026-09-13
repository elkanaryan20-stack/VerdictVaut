import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PendingVerificationBanner } from "../components/auth/PendingVerificationBanner";
import { ApiError } from "../lib/api-client";
import { useAuth } from "../lib/auth/auth-context";

jest.mock("../lib/auth/auth-context", () => ({ useAuth: jest.fn() }));
const mockedUseAuth = useAuth as jest.Mock;

describe("PendingVerificationBanner", () => {
  const resendVerificationEmail = jest.fn();

  beforeEach(() => {
    resendVerificationEmail.mockReset();
    mockedUseAuth.mockReturnValue({ resendVerificationEmail });
  });

  it("does not resend automatically on mount", () => {
    render(<PendingVerificationBanner />);
    expect(resendVerificationEmail).not.toHaveBeenCalled();
  });

  it("shows a loading state while sending, then a generic success message", async () => {
    let resolveSend: () => void = () => undefined;
    resendVerificationEmail.mockReturnValue(new Promise<void>((resolve) => (resolveSend = resolve)));
    const user = userEvent.setup();
    render(<PendingVerificationBanner />);

    await user.click(screen.getByRole("button", { name: /resend verification email/i }));
    expect(screen.getByRole("button", { name: /sending/i })).toBeDisabled();

    resolveSend();
    expect(await screen.findByText(/new verification email is on its way/i)).toBeInTheDocument();
  });

  it("disables the button after a successful send — prevents accidental repeated clicks", async () => {
    resendVerificationEmail.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<PendingVerificationBanner />);
    await user.click(screen.getByRole("button", { name: /resend verification email/i }));
    expect(await screen.findByRole("button", { name: "Sent" })).toBeDisabled();
    expect(resendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("shows a rate-limit message on 429 and allows retrying afterward", async () => {
    resendVerificationEmail.mockRejectedValue(new ApiError(429, "Too many requests"));
    const user = userEvent.setup();
    render(<PendingVerificationBanner />);
    await user.click(screen.getByRole("button", { name: /resend verification email/i }));
    expect(await screen.findByText(/too many requests/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resend verification email/i })).not.toBeDisabled();
  });

  it("shows a generic error on any other failure — never a provider-specific/secret-bearing message", async () => {
    resendVerificationEmail.mockRejectedValue(new Error("ECONNREFUSED at postmarkapp.com with token xyz"));
    const user = userEvent.setup();
    render(<PendingVerificationBanner />);
    await user.click(screen.getByRole("button", { name: /resend verification email/i }));
    expect(await screen.findByText(/couldn.t send a new verification email/i)).toBeInTheDocument();
    expect(screen.queryByText(/postmarkapp\.com/i)).not.toBeInTheDocument();
  });
});
