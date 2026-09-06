import { screen, waitFor } from "@testing-library/react";
import { BalanceSummaryCards } from "../components/wallet/BalanceSummaryCards";
import { renderWithQueryClient } from "../test-support/render";
import * as walletApi from "../lib/wallet/api";
import { ApiError } from "../lib/api-client";

jest.mock("../lib/wallet/api");

const mockedApi = walletApi as jest.Mocked<typeof walletApi>;

describe("BalanceSummaryCards", () => {
  it("shows loading skeletons before data arrives", () => {
    mockedApi.fetchBalances.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithQueryClient(<BalanceSummaryCards />);
    expect(screen.getAllByTestId("skeleton").length).toBeGreaterThan(0);
  });

  it("renders available and reserved as distinct, correctly labeled figures for the settlement asset (USDC)", async () => {
    mockedApi.fetchBalances.mockResolvedValue([
      { assetId: "a1", symbol: "USDC", name: "USD Coin", decimals: 6, assetClass: "TOKEN", totalBalance: "500", reservedBalance: "125", availableBalance: "375" },
      { assetId: "a2", symbol: "BTC", name: "Bitcoin", decimals: 8, assetClass: "NATIVE", totalBalance: "0", reservedBalance: "0", availableBalance: "0" },
    ]);

    renderWithQueryClient(<BalanceSummaryCards />);

    await waitFor(() => expect(screen.getByText("375")).toBeInTheDocument());
    expect(screen.getByText("125")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
    // Reserved must never be rendered as if it were the available/spendable figure.
    expect(screen.getByText(/available/i)).toBeInTheDocument();
    expect(screen.getByText(/reserved/i)).toBeInTheDocument();
  });

  it("shows an error state on API failure rather than fabricating a balance", async () => {
    mockedApi.fetchBalances.mockRejectedValue(new ApiError(500, "Internal server error"));
    renderWithQueryClient(<BalanceSummaryCards />);
    await waitFor(() => expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument());
  });
});
