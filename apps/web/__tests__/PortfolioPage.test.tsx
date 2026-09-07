import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PortfolioPage from "../app/portfolio/page";
import { renderWithQueryClient } from "../test-support/render";
import * as tradingApi from "../lib/trading/api";

jest.mock("../lib/trading/api");
const mockedApi = tradingApi as jest.Mocked<typeof tradingApi>;

describe("PortfolioPage", () => {
  beforeEach(() => {
    mockedApi.fetchMyOrders.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    mockedApi.fetchMyPositions.mockResolvedValue([]);
    mockedApi.fetchMyFills.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    mockedApi.fetchMarkets.mockResolvedValue([]);
    mockedApi.fetchMySettlement.mockResolvedValue([]);
  });

  it("defaults to the open orders tab", async () => {
    renderWithQueryClient(<PortfolioPage />);
    expect(await screen.findByText("You have no open orders.")).toBeInTheDocument();
  });

  it("switches to the settlement tab and loads settlement history without any other tab's data leaking in", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<PortfolioPage />);

    await screen.findByText("You have no open orders.");
    await user.click(screen.getByRole("tab", { name: "Settlement" }));

    expect(await screen.findByText("No settled positions yet.")).toBeInTheDocument();
    expect(screen.queryByText("You have no open orders.")).not.toBeInTheDocument();
  });

  it("switches to the fills tab on click", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<PortfolioPage />);

    await screen.findByText("You have no open orders.");
    await user.click(screen.getByRole("tab", { name: "Fills" }));

    expect(await screen.findByText("You have no fills yet.")).toBeInTheDocument();
  });
});
