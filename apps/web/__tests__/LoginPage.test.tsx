import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LoginPage from "../app/login/page";
import { ApiError } from "../lib/api-client";
import { useAuth } from "../lib/auth/auth-context";

const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
jest.mock("../lib/auth/auth-context", () => ({ useAuth: jest.fn() }));
const mockedUseAuth = useAuth as jest.Mock;

async function submitWith(error: unknown) {
  mockedUseAuth.mockReturnValue({ status: "unauthenticated", login: jest.fn().mockRejectedValue(error) });
  const user = userEvent.setup();
  render(<LoginPage />);
  await user.type(screen.getByLabelText("Email"), "a@b.c");
  await user.type(screen.getByLabelText("Password"), "correct-horse");
  await user.click(screen.getByRole("button", { name: /log in|sign in/i }));
}

describe("LoginPage error states (Phase 36)", () => {
  it("tells a suspended account it is suspended (backend 403 is only reachable with the right password)", async () => {
    await submitWith(new ApiError(403, "Account is suspended"));
    expect(await screen.findByText(/this account is suspended/i)).toBeInTheDocument();
    expect(screen.queryByText(/invalid email or password/i)).not.toBeInTheDocument();
  });

  it("keeps the generic message for bad credentials (no account-existence oracle)", async () => {
    await submitWith(new ApiError(401, "Invalid email or password"));
    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
  });

  it("asks the user to wait when throttled", async () => {
    await submitWith(new ApiError(429, "Too many requests"));
    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
  });
});
