import type { Deposit } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import { DepositDetail } from "../components/wallet/DepositDetail";
import { renderWithQueryClient } from "../test-support/render";
import * as walletApi from "../lib/wallet/api";
import { ApiError } from "../lib/api-client";

jest.mock("../lib/wallet/api");
const mockedApi = walletApi as jest.Mocked<typeof walletApi>;

function makeDeposit(overrides: Partial<Deposit>): Deposit {
  return {
    id: "dep-1",
    userId: "user-1",
    assetId: "asset-1",
    assetNetworkId: "an-1",
    walletAddressId: "wa-1",
    txHash: "0xabcdef1234567890abcdef1234567890",
    eventIndex: 0,
    amount: "40",
    confirmations: 3,
    requiredConfirmations: 12,
    status: "PENDING",
    destinationTag: null,
    failureReason: null,
    retryCount: 0,
    ledgerTransactionId: null,
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

describe("DepositDetail", () => {
  it("shows confirmation progress for a PENDING deposit, using only backend-reported numbers", async () => {
    mockedApi.fetchDeposit.mockResolvedValue(makeDeposit({}));
    renderWithQueryClient(<DepositDetail depositId="dep-1" />);
    await waitFor(() => expect(screen.getByText("3 / 12 confirmations")).toBeInTheDocument());
  });

  it("never shows confirmation progress once CREDITED", async () => {
    mockedApi.fetchDeposit.mockResolvedValue(makeDeposit({ status: "CREDITED", confirmations: 12, creditedAt: new Date().toISOString() }));
    renderWithQueryClient(<DepositDetail depositId="dep-1" />);
    await waitFor(() => expect(screen.getAllByText("Credited").length).toBeGreaterThan(0));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("shows the failure reason and a recovery message for a FAILED deposit", async () => {
    mockedApi.fetchDeposit.mockResolvedValue(
      makeDeposit({ status: "FAILED", failureReason: "Destination tag mismatch: observed 1, expected 2" }),
    );
    renderWithQueryClient(<DepositDetail depositId="dep-1" />);
    await waitFor(() => expect(screen.getByText(/needs attention/i)).toBeInTheDocument());
    expect(screen.getByText(/destination tag mismatch/i)).toBeInTheDocument();
  });

  it("shows a rejected state distinct from failed", async () => {
    mockedApi.fetchDeposit.mockResolvedValue(makeDeposit({ status: "REJECTED", failureReason: "Reorged out" }));
    renderWithQueryClient(<DepositDetail depositId="dep-1" />);
    await waitFor(() => expect(screen.getByText(/was rejected/i)).toBeInTheDocument());
  });

  it("shows a not-found message for a 404, without a generic retry (nothing to retry)", async () => {
    mockedApi.fetchDeposit.mockRejectedValue(new ApiError(404, "Not found"));
    renderWithQueryClient(<DepositDetail depositId="missing" />);
    await waitFor(() => expect(screen.getByText(/doesn't exist, or doesn't belong to your account/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
  });

  it("shows the XRP destination tag on the record when present", async () => {
    mockedApi.fetchDeposit.mockResolvedValue(makeDeposit({ destinationTag: "104598917" }));
    renderWithQueryClient(<DepositDetail depositId="dep-1" />);
    await waitFor(() => expect(screen.getByText("104598917")).toBeInTheDocument());
  });
});
