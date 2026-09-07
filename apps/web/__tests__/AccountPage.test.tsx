import { screen } from "@testing-library/react";
import { render } from "@testing-library/react";
import AccountPage from "../app/account/page";
import { useAuth } from "../lib/auth/auth-context";

jest.mock("../lib/auth/auth-context", () => ({ useAuth: jest.fn() }));

const mockedUseAuth = useAuth as jest.Mock;

function user(role: "USER" | "ADMIN" | "SUPER_ADMIN") {
  return { id: "u1", email: "a@b.com", role, status: "ACTIVE" as const, createdAt: new Date().toISOString() };
}

describe("AccountPage", () => {
  it("does not show an Admin quick-link for a normal USER", () => {
    mockedUseAuth.mockReturnValue({ user: user("USER") });
    render(<AccountPage />);
    expect(screen.queryByText("Restricted operations dashboard.")).not.toBeInTheDocument();
  });

  it("shows an Admin quick-link for a SUPER_ADMIN — this is how they reach /admin on mobile without a 6th bottom-nav item", () => {
    mockedUseAuth.mockReturnValue({ user: user("SUPER_ADMIN") });
    render(<AccountPage />);
    expect(screen.getByText("Restricted operations dashboard.")).toBeInTheDocument();
  });
});
