import type { Withdrawal } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import { WithdrawalHistoryTable } from "../components/wallet/WithdrawalHistoryTable";
import { renderWithQueryClient } from "../test-support/render";
import * as walletApi from "../lib/wallet/api";

jest.mock("../lib/wallet/api");
const mockedApi = walletApi as jest.Mocked<typeof walletApi>;

function makeWithdrawal(overrides: Partial<Withdrawal> = {}): Withdrawal {
  return {
    id: "wd-1",
    userId: "user-1",
    assetNetworkId: "an-1",
    destinationAddress: "0xDestinationAddress1234567890",
    destinationTag: null,
    amount: "50",
    fee: "0",
    status: "RISK_REVIEW",
    txHash: null,
    custodyReference: null,
    broadcastByAdminId: null,
    broadcastAt: null,
    confirmedAt: null,
    failureReason: null,
    complianceDecision: "DEFERRED",
    complianceNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assetNetwork: {
      id: "an-1",
      asset: { id: "asset-1", symbol: "USDC", name: "USD Coin", decimals: 6, assetClass: "TOKEN", isSettlementCurrency: true, isActive: true },
      network: { id: "net-1", code: "ethereum-sepolia", family: "EVM", environment: "SANDBOX", name: "Ethereum Sepolia", isActive: true },
    },
    ...overrides,
  };
}

describe("WithdrawalHistoryTable", () => {
  it("shows an empty state when there are no withdrawals", async () => {
    mockedApi.fetchWithdrawals.mockResolvedValue([]);
    renderWithQueryClient(<WithdrawalHistoryTable />);
    expect(await screen.findByText("No withdrawals yet")).toBeInTheDocument();
  });

  it("shows an error state on API failure", async () => {
    mockedApi.fetchWithdrawals.mockRejectedValue(new Error("network down"));
    renderWithQueryClient(<WithdrawalHistoryTable />);
    expect(await screen.findByText("Couldn't load your withdrawal history.")).toBeInTheDocument();
  });

  it("lists a withdrawal with its asset, status, and a placeholder for a not-yet-broadcast transaction", async () => {
    mockedApi.fetchWithdrawals.mockResolvedValue([makeWithdrawal()]);
    renderWithQueryClient(<WithdrawalHistoryTable />);

    await waitFor(() => expect(screen.getAllByText("USDC").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Pending review").length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows a truncated transaction hash once one has been recorded", async () => {
    mockedApi.fetchWithdrawals.mockResolvedValue([
      makeWithdrawal({ status: "BROADCAST", txHash: "0xabcdef1234567890abcdef1234567890abcdef" }),
    ]);
    renderWithQueryClient(<WithdrawalHistoryTable />);
    await waitFor(() => expect(screen.getAllByText("Broadcast").length).toBeGreaterThan(0));
    expect(screen.getByText(/0xabcdef…/)).toBeInTheDocument();
  });
});
