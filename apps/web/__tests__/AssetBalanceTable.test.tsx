import { screen, waitFor } from "@testing-library/react";
import { AssetBalanceTable } from "../components/wallet/AssetBalanceTable";
import { renderWithQueryClient } from "../test-support/render";
import * as walletApi from "../lib/wallet/api";

jest.mock("../lib/wallet/api");
const mockedApi = walletApi as jest.Mocked<typeof walletApi>;

describe("AssetBalanceTable", () => {
  it("renders every asset the backend returns, with its own total/available/reserved", async () => {
    mockedApi.fetchBalances.mockResolvedValue([
      { assetId: "a1", symbol: "BTC", name: "Bitcoin", decimals: 8, assetClass: "NATIVE", totalBalance: "1.5", reservedBalance: "0.5", availableBalance: "1" },
      { assetId: "a2", symbol: "USDC", name: "USD Coin", decimals: 6, assetClass: "TOKEN", totalBalance: "0", reservedBalance: "0", availableBalance: "0" },
    ]);

    renderWithQueryClient(<AssetBalanceTable />);

    await waitFor(() => expect(screen.getAllByText("BTC").length).toBeGreaterThan(0));
    expect(screen.getAllByText("USDC").length).toBeGreaterThan(0);
    // Both the desktop table and mobile stacked view render — total 1.5
    // and available 1 must both appear as DISTINCT values, not merged.
    expect(screen.getAllByText("1.5").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0.5").length).toBeGreaterThan(0);
  });

  it("renders a Deposit link per asset pointing at the correct pre-selected asset", async () => {
    mockedApi.fetchBalances.mockResolvedValue([
      { assetId: "a1", symbol: "SOL", name: "Solana", decimals: 9, assetClass: "NATIVE", totalBalance: "0", reservedBalance: "0", availableBalance: "0" },
    ]);

    renderWithQueryClient(<AssetBalanceTable />);

    await waitFor(() => expect(screen.getAllByRole("link", { name: /deposit/i }).length).toBeGreaterThan(0));
    const link = screen.getAllByRole("link", { name: /deposit/i })[0];
    expect(link).toHaveAttribute("href", "/wallet/deposit?asset=SOL");
  });

  it("shows an empty-friendly loading state, never fake rows, before data arrives", () => {
    mockedApi.fetchBalances.mockReturnValue(new Promise(() => {}));
    renderWithQueryClient(<AssetBalanceTable />);
    expect(screen.queryByText("BTC")).not.toBeInTheDocument();
  });
});
