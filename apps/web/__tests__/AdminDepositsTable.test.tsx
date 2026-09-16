import type { AdminDeposit, StaleDeposit } from "@verdictvaut/shared-types";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminDepositsTable } from "../components/admin/AdminDepositsTable";
import { renderWithQueryClient } from "../test-support/render";
import { useAuth } from "../lib/auth/auth-context";
import * as adminApi from "../lib/admin/api";

jest.mock("../lib/admin/api");
jest.mock("../lib/auth/auth-context", () => ({ useAuth: jest.fn() }));

const mockedApi = adminApi as jest.Mocked<typeof adminApi>;
const mockedUseAuth = useAuth as jest.Mock;

const asset = { id: "asset-1", symbol: "USDC" as const, name: "USD Coin", decimals: 6, assetClass: "TOKEN" as const, isSettlementCurrency: true, isActive: true };
const network = { id: "network-1", code: "ETH", family: "EVM" as const, environment: "SANDBOX" as const, name: "Ethereum", isActive: true };

function deposit(overrides: Partial<AdminDeposit> = {}): AdminDeposit {
  return {
    id: "deposit-1",
    userId: "user-1",
    assetId: "asset-1",
    assetNetworkId: "an-1",
    walletAddressId: "wallet-1",
    txHash: "0xabc123def456abc123def456abc123def456abc",
    eventIndex: 0,
    amount: "100",
    confirmations: 12,
    requiredConfirmations: 12,
    status: "CREDITED",
    destinationTag: null,
    failureReason: null,
    retryCount: 0,
    ledgerTransactionId: "ledger-1",
    detectedAt: new Date().toISOString(),
    lastCheckedAt: null,
    confirmedAt: null,
    creditedAt: null,
    user: { id: "user-1", email: "trader@example.com" },
    assetNetwork: { id: "an-1", asset, network },
    ...overrides,
  };
}

function staleDeposit(overrides: Partial<StaleDeposit> = {}): StaleDeposit {
  return {
    id: "deposit-1",
    userId: "user-1",
    assetNetworkId: "an-1",
    txHash: "0xabc",
    amount: "100",
    status: "PENDING",
    detectedAt: new Date().toISOString(),
    lastCheckedAt: null,
    ...overrides,
  };
}

describe("AdminDepositsTable", () => {
  beforeEach(() => {
    mockedApi.fetchStaleDeposits.mockResolvedValue([]);
  });

  it("shows an empty state when there are no deposits", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "ADMIN" } });
    mockedApi.fetchAdminDeposits.mockResolvedValue([]);
    renderWithQueryClient(<AdminDepositsTable />);
    expect(await screen.findByText("No deposits recorded yet.")).toBeInTheDocument();
  });

  it("never shows a Reprocess control for a plain ADMIN — the backend also enforces this, but the UI shouldn't offer it", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "ADMIN" } });
    mockedApi.fetchAdminDeposits.mockResolvedValue([deposit()]);
    renderWithQueryClient(<AdminDepositsTable />);
    await screen.findByText("trader@example.com");
    expect(screen.queryByRole("button", { name: "Reprocess" })).not.toBeInTheDocument();
  });

  it("badges a deposit as needing attention when it appears in the stale-deposits list", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    mockedApi.fetchAdminDeposits.mockResolvedValue([deposit()]);
    mockedApi.fetchStaleDeposits.mockResolvedValue([staleDeposit()]);
    renderWithQueryClient(<AdminDepositsTable />);
    expect(await screen.findByText("Needs attention")).toBeInTheDocument();
  });

  it("a SUPER_ADMIN reprocessing a deposit sees a confirmation dialog before anything is called", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    mockedApi.fetchAdminDeposits.mockResolvedValue([deposit()]);
    const user = userEvent.setup();
    renderWithQueryClient(<AdminDepositsTable />);

    await user.click(await screen.findByRole("button", { name: "Reprocess" }));
    expect(await screen.findByText("Reprocess this deposit?")).toBeInTheDocument();
    expect(mockedApi.reprocessDeposit).not.toHaveBeenCalled();
  });

  it("only calls reprocessDeposit after the dialog is confirmed", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    mockedApi.fetchAdminDeposits.mockResolvedValue([deposit()]);
    mockedApi.reprocessDeposit.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithQueryClient(<AdminDepositsTable />);

    await user.click(await screen.findByRole("button", { name: "Reprocess" }));
    await user.click(await screen.findByRole("button", { name: "Reprocess deposit" }));

    expect(mockedApi.reprocessDeposit).toHaveBeenCalledWith("deposit-1");
  });

  it("shows an error state on API failure", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "ADMIN" } });
    mockedApi.fetchAdminDeposits.mockRejectedValue(new Error("network down"));
    renderWithQueryClient(<AdminDepositsTable />);
    expect(await screen.findByText("Couldn't load deposits.")).toBeInTheDocument();
  });

  describe("pagination (Phase 30)", () => {
    it("requests page 1 on first render, and Previous is disabled", async () => {
      mockedUseAuth.mockReturnValue({ user: { role: "ADMIN" } });
      mockedApi.fetchAdminDeposits.mockResolvedValue([deposit()]);
      renderWithQueryClient(<AdminDepositsTable />);
      await screen.findByText("trader@example.com");

      expect(mockedApi.fetchAdminDeposits).toHaveBeenCalledWith(1, 50);
      expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();
    });

    it("Next is disabled when a page returns fewer rows than the page size (no more pages)", async () => {
      mockedUseAuth.mockReturnValue({ user: { role: "ADMIN" } });
      mockedApi.fetchAdminDeposits.mockResolvedValue([deposit()]); // 1 row, page size 50
      renderWithQueryClient(<AdminDepositsTable />);
      await screen.findByText("trader@example.com");

      expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
    });

    it("Next is enabled and advances to page 2 when a page returns a full page of rows", async () => {
      mockedUseAuth.mockReturnValue({ user: { role: "ADMIN" } });
      const fullPage = Array.from({ length: 50 }, (_, i) => deposit({ id: `deposit-${i}`, txHash: `0x${i}`, user: { id: `user-${i}`, email: `trader-${i}@example.com` } }));
      mockedApi.fetchAdminDeposits.mockResolvedValue(fullPage);
      const user = userEvent.setup();
      renderWithQueryClient(<AdminDepositsTable />);
      await screen.findByText("trader-0@example.com");

      const nextButton = screen.getByRole("button", { name: /next/i });
      expect(nextButton).not.toBeDisabled();

      await user.click(nextButton);
      expect(mockedApi.fetchAdminDeposits).toHaveBeenCalledWith(2, 50);
    });
  });
});
