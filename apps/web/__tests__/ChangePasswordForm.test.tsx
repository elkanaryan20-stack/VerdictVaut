import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangePasswordForm } from "../components/account/ChangePasswordForm";
import { renderWithQueryClient } from "../test-support/render";
import { ApiError } from "../lib/api-client";
import { useAuth } from "../lib/auth/auth-context";
import * as accountApi from "../lib/account/api";

jest.mock("../lib/account/api");
jest.mock("../lib/auth/auth-context", () => ({ useAuth: jest.fn() }));
const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const mockedApi = accountApi as jest.Mocked<typeof accountApi>;
const mockedUseAuth = useAuth as jest.Mock;

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>, overrides: { current?: string; next?: string; confirm?: string } = {}) {
  await user.type(screen.getByLabelText("Current password"), overrides.current ?? "old-password-123");
  await user.type(screen.getByLabelText("New password"), overrides.next ?? "brand-new-password-1");
  await user.type(screen.getByLabelText("Confirm new password"), overrides.confirm ?? "brand-new-password-1");
  await user.click(screen.getByRole("button", { name: "Change password" }));
}

describe("ChangePasswordForm", () => {
  const logout = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    logout.mockClear();
    replace.mockClear();
    mockedUseAuth.mockReturnValue({ logout });
  });

  it("rejects a mismatched confirmation without calling the API", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ChangePasswordForm />);
    await fillAndSubmit(user, { confirm: "does-not-match-1" });
    expect(await screen.findByText("New password and confirmation don't match.")).toBeInTheDocument();
    expect(mockedApi.changePassword).not.toHaveBeenCalled();
  });

  it("rejects a too-short new password client-side", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ChangePasswordForm />);
    await fillAndSubmit(user, { next: "short", confirm: "short" });
    expect(await screen.findByText("New password must be at least 12 characters.")).toBeInTheDocument();
    expect(mockedApi.changePassword).not.toHaveBeenCalled();
  });

  it("surfaces an incorrect-current-password error from the backend", async () => {
    mockedApi.changePassword.mockRejectedValue(new ApiError(403, "Current password is incorrect"));
    const user = userEvent.setup();
    renderWithQueryClient(<ChangePasswordForm />);
    await fillAndSubmit(user);
    expect(await screen.findByText("Current password is incorrect.")).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });

  it("on success, shows the sign-out notice and signs the user out on confirmation — never claims success silently", async () => {
    mockedApi.changePassword.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithQueryClient(<ChangePasswordForm />);
    await fillAndSubmit(user);

    expect(await screen.findByText(/you've been signed out everywhere/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue to sign in" }));
    expect(logout).toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith("/login");
  });
});
