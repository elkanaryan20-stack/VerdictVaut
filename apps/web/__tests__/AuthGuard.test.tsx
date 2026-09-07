import { render, screen } from "@testing-library/react";
import { AuthGuard } from "../components/layout/AuthGuard";
import { useAuth } from "../lib/auth/auth-context";

jest.mock("../lib/auth/auth-context", () => ({ useAuth: jest.fn() }));

const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const mockedUseAuth = useAuth as jest.Mock;

describe("AuthGuard", () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it("renders a loading state and no protected content while auth status is unknown", () => {
    mockedUseAuth.mockReturnValue({ status: "loading", user: null });
    render(
      <AuthGuard>
        <div>Secret wallet data</div>
      </AuthGuard>,
    );
    expect(screen.queryByText("Secret wallet data")).not.toBeInTheDocument();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("redirects to /login and renders nothing when unauthenticated — never shows wallet content", () => {
    mockedUseAuth.mockReturnValue({ status: "unauthenticated", user: null });
    render(
      <AuthGuard>
        <div>Secret wallet data</div>
      </AuthGuard>,
    );
    expect(screen.queryByText("Secret wallet data")).not.toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("renders children once authenticated", () => {
    mockedUseAuth.mockReturnValue({ status: "authenticated", user: { id: "u1", email: "a@b.com" } });
    render(
      <AuthGuard>
        <div>Secret wallet data</div>
      </AuthGuard>,
    );
    expect(screen.getByText("Secret wallet data")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("blocks an authenticated user whose role isn't in `allow`, without redirecting to /login", () => {
    mockedUseAuth.mockReturnValue({ status: "authenticated", user: { id: "u1", email: "a@b.com", role: "USER" } });
    render(
      <AuthGuard allow={["ADMIN", "SUPER_ADMIN"]}>
        <div>Restricted admin data</div>
      </AuthGuard>,
    );
    expect(screen.queryByText("Restricted admin data")).not.toBeInTheDocument();
    expect(screen.getByText(/restricted area/i)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("renders children when the user's role is in `allow`", () => {
    mockedUseAuth.mockReturnValue({ status: "authenticated", user: { id: "u1", email: "a@b.com", role: "SUPER_ADMIN" } });
    render(
      <AuthGuard allow={["ADMIN", "SUPER_ADMIN"]}>
        <div>Restricted admin data</div>
      </AuthGuard>,
    );
    expect(screen.getByText("Restricted admin data")).toBeInTheDocument();
  });
});
