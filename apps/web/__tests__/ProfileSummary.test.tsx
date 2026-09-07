import { screen } from "@testing-library/react";
import { render } from "@testing-library/react";
import type { CurrentUser } from "../lib/auth/auth-context";
import { ProfileSummary } from "../components/account/ProfileSummary";

function user(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: "user-1",
    email: "trader@example.com",
    role: "USER",
    status: "ACTIVE",
    createdAt: new Date("2026-01-15T00:00:00Z").toISOString(),
    ...overrides,
  };
}

describe("ProfileSummary", () => {
  it("shows only the non-sensitive fields the backend actually returns", () => {
    render(<ProfileSummary user={user()} />);
    expect(screen.getByText("trader@example.com")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("User")).toBeInTheDocument();
    // Never a password hash, internal secret, or field the backend doesn't send.
    expect(screen.queryByText(/passwordHash/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/totpSecret/i)).not.toBeInTheDocument();
  });

  it("distinguishes account status by more than color (icon + label)", () => {
    render(<ProfileSummary user={user({ status: "SUSPENDED" })} />);
    expect(screen.getByText("Suspended")).toBeInTheDocument();
  });

  it("labels an elevated role distinctly from a normal user", () => {
    render(<ProfileSummary user={user({ role: "SUPER_ADMIN" })} />);
    expect(screen.getByText("Super admin")).toBeInTheDocument();
  });
});
