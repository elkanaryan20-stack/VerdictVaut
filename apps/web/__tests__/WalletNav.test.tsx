import { screen } from "@testing-library/react";
import { render } from "@testing-library/react";
import { WalletMobileNav, WalletSidebar } from "../components/layout/WalletNav";
import { useAuth } from "../lib/auth/auth-context";

jest.mock("../lib/auth/auth-context", () => ({ useAuth: jest.fn() }));
jest.mock("next/navigation", () => ({ usePathname: () => "/markets", useRouter: () => ({ replace: jest.fn() }) }));

const mockedUseAuth = useAuth as jest.Mock;

describe("WalletNav", () => {
  it("hides the Admin link from the desktop sidebar for a normal USER", () => {
    mockedUseAuth.mockReturnValue({ status: "authenticated", user: { id: "u1", email: "a@b.com", role: "USER" }, logout: jest.fn() });
    render(<WalletSidebar />);
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
  });

  it("shows the Admin link in the desktop sidebar for an ADMIN", () => {
    mockedUseAuth.mockReturnValue({ status: "authenticated", user: { id: "u1", email: "a@b.com", role: "ADMIN" }, logout: jest.fn() });
    render(<WalletSidebar />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("shows the Admin link in the desktop sidebar for a SUPER_ADMIN", () => {
    mockedUseAuth.mockReturnValue({ status: "authenticated", user: { id: "u1", email: "a@b.com", role: "SUPER_ADMIN" }, logout: jest.fn() });
    render(<WalletSidebar />);
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("never shows Admin in the mobile bottom nav, even for a SUPER_ADMIN — it always stays at 5 items so the bar stays usable", () => {
    mockedUseAuth.mockReturnValue({ status: "authenticated", user: { id: "u1", email: "a@b.com", role: "SUPER_ADMIN" }, logout: jest.fn() });
    render(<WalletMobileNav />);
    expect(screen.queryByText("Admin")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(5);
  });

  it("always shows the primary nav items regardless of role", () => {
    mockedUseAuth.mockReturnValue({ status: "authenticated", user: { id: "u1", email: "a@b.com", role: "USER" }, logout: jest.fn() });
    render(<WalletSidebar />);
    expect(screen.getByText("Markets")).toBeInTheDocument();
    expect(screen.getByText("Portfolio")).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("Account")).toBeInTheDocument();
  });
});
