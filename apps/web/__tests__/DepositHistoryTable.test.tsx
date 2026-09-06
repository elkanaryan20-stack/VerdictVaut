import type { Deposit } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DepositHistoryTable } from "../components/wallet/DepositHistoryTable";
import { renderWithQueryClient } from "../test-support/render";
import * as walletApi from "../lib/wallet/api";

jest.mock("../lib/wallet/api");
const mockedApi = walletApi as jest.Mocked<typeof walletApi>;

function makeDeposit(overrides: Partial<Deposit>): Deposit {
  return {
    id: "dep-1",
    userId: "user-1",
    assetId: "asset-1",
    assetNetworkId: "an-1",
    walletAddressId: "wa-1",
    txHash: "0xhash1234567890",
    eventIndex: 0,
    amount: "10",
    confirmations: 12,
    requiredConfirmations: 12,
    status: "CREDITED",
    destinationTag: null,
    failureReason: null,
    retryCount: 0,
    ledgerTransactionId: "ltx-1",
    detectedAt: new Date().toISOString(),
    lastCheckedAt: null,
    confirmedAt: null,
    creditedAt: null,
    assetNetwork: {
      id: "an-1",
      asset: { id: "asset-1", symbol: "USDC", name: "USD Coin", decimals: 6, assetClass: "TOKEN", isSettlementCurrency: true, isActive: true },
      network: { id: "net-1", code: "ethereum-sepolia", family: "EVM", environment: "SANDBOX", name: "Ethereum Sepolia", isActive: true },
    },
    ...overrides,
  };
}

describe("DepositHistoryTable", () => {
  it("shows a friendly empty state with no fabricated rows when there are no deposits", async () => {
    mockedApi.fetchDeposits.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    renderWithQueryClient(<DepositHistoryTable />);
    await waitFor(() => expect(screen.getByText("No deposits yet")).toBeInTheDocument());
  });

  it("renders deposit rows with asset, amount, and status", async () => {
    mockedApi.fetchDeposits.mockResolvedValue({
      items: [makeDeposit({ id: "dep-1" })],
      total: 1,
      page: 1,
      pageSize: 10,
    });
    renderWithQueryClient(<DepositHistoryTable />);
    await waitFor(() => expect(screen.getAllByText("USDC").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Credited").length).toBeGreaterThan(0);
  });

  it("uses backend pagination — requests page 2 on Next, not a client-side slice of everything", async () => {
    mockedApi.fetchDeposits.mockImplementation(async (page) => ({
      items: [makeDeposit({ id: `dep-page-${page}` })],
      total: 25,
      page,
      pageSize: 10,
    }));

    const user = userEvent.setup();
    renderWithQueryClient(<DepositHistoryTable />);

    await waitFor(() => expect(screen.getByText("Page 1 of 3")).toBeInTheDocument());
    expect(mockedApi.fetchDeposits).toHaveBeenCalledWith(1, 10);

    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => expect(mockedApi.fetchDeposits).toHaveBeenCalledWith(2, 10));
  });

  it("disables Previous on the first page and Next on the last page", async () => {
    mockedApi.fetchDeposits.mockResolvedValue({ items: [makeDeposit({})], total: 1, page: 1, pageSize: 10 });
    renderWithQueryClient(<DepositHistoryTable />);
    await waitFor(() => expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled());
    expect(screen.getByRole("button", { name: /next/i })).toBeDisabled();
  });

  it("shows a retry option on failure, without fabricating history", async () => {
    mockedApi.fetchDeposits.mockRejectedValue(new Error("network down"));
    renderWithQueryClient(<DepositHistoryTable />);
    await waitFor(() => expect(screen.getByText(/couldn't load your deposit history/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
