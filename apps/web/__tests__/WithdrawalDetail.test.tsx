import type { Withdrawal } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WithdrawalDetail } from "../components/wallet/WithdrawalDetail";
import { renderWithQueryClient } from "../test-support/render";
import * as walletApi from "../lib/wallet/api";
import { ApiError } from "../lib/api-client";

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

describe("WithdrawalDetail", () => {
  it("shows the amount and estimated received when there is no fee", async () => {
    mockedApi.fetchWithdrawal.mockResolvedValue(makeWithdrawal());
    renderWithQueryClient(<WithdrawalDetail withdrawalId="wd-1" />);
    await waitFor(() => expect(screen.getByText("Amount")).toBeInTheDocument());
    expect(screen.queryByText("Fee")).not.toBeInTheDocument();
    expect(screen.getByText("Estimated received")).toBeInTheDocument();
  });

  it("shows a distinct fee row and a correctly reduced estimated-received figure when a fee applies", async () => {
    mockedApi.fetchWithdrawal.mockResolvedValue(makeWithdrawal({ amount: "50", fee: "1.5" }));
    renderWithQueryClient(<WithdrawalDetail withdrawalId="wd-1" />);
    await waitFor(() => expect(screen.getByText("Fee")).toBeInTheDocument());
    expect(screen.getByText("1.5")).toBeInTheDocument();
    expect(screen.getByText("48.5")).toBeInTheDocument();
  });

  it("offers a cancel button only while the withdrawal is still cancellable", async () => {
    mockedApi.fetchWithdrawal.mockResolvedValue(makeWithdrawal({ status: "RISK_REVIEW" }));
    renderWithQueryClient(<WithdrawalDetail withdrawalId="wd-1" />);
    expect(await screen.findByRole("button", { name: "Cancel withdrawal" })).toBeInTheDocument();
  });

  it("never offers a cancel button once approved", async () => {
    mockedApi.fetchWithdrawal.mockResolvedValue(makeWithdrawal({ status: "APPROVED" }));
    renderWithQueryClient(<WithdrawalDetail withdrawalId="wd-1" />);
    await waitFor(() => expect(screen.getByText("Approved")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Cancel withdrawal" })).not.toBeInTheDocument();
  });

  it("calls cancelWithdrawal only when the cancel button is clicked", async () => {
    mockedApi.fetchWithdrawal.mockResolvedValue(makeWithdrawal({ status: "RISK_REVIEW" }));
    mockedApi.cancelWithdrawal.mockResolvedValue(makeWithdrawal({ status: "CANCELLED" }));
    const user = userEvent.setup();
    renderWithQueryClient(<WithdrawalDetail withdrawalId="wd-1" />);

    const cancelButton = await screen.findByRole("button", { name: "Cancel withdrawal" });
    expect(mockedApi.cancelWithdrawal).not.toHaveBeenCalled();
    await user.click(cancelButton);
    expect(mockedApi.cancelWithdrawal).toHaveBeenCalledWith("wd-1");
  });

  it("shows the failure reason for a rejected withdrawal, distinct from a failed one", async () => {
    mockedApi.fetchWithdrawal.mockResolvedValue(makeWithdrawal({ status: "REJECTED", failureReason: "Destination address failed validation" }));
    renderWithQueryClient(<WithdrawalDetail withdrawalId="wd-1" />);
    await waitFor(() => expect(screen.getByText(/was rejected/i)).toBeInTheDocument());
    expect(screen.getByText(/destination address failed validation/i)).toBeInTheDocument();
  });

  it("shows a not-found message for a 404, without a generic retry", async () => {
    mockedApi.fetchWithdrawal.mockRejectedValue(new ApiError(404, "Not found"));
    renderWithQueryClient(<WithdrawalDetail withdrawalId="missing" />);
    await waitFor(() => expect(screen.getByText(/doesn't exist, or doesn't belong to your account/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("shows the destination tag when present", async () => {
    mockedApi.fetchWithdrawal.mockResolvedValue(makeWithdrawal({ destinationTag: "104598917" }));
    renderWithQueryClient(<WithdrawalDetail withdrawalId="wd-1" />);
    await waitFor(() => expect(screen.getByText("104598917")).toBeInTheDocument());
  });
});
