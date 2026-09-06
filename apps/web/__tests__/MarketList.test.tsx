import type { Market } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarketList } from "../components/markets/MarketList";
import { renderWithQueryClient } from "../test-support/render";
import * as tradingApi from "../lib/trading/api";

jest.mock("../lib/trading/api");
const mockedApi = tradingApi as jest.Mocked<typeof tradingApi>;

beforeEach(() => {
  jest.clearAllMocks();
});

function market(overrides: Partial<Market>): Market {
  return {
    id: "market-1",
    slug: "market-1",
    title: "Will it rain?",
    description: "A test market.",
    categoryId: "cat-1",
    status: "OPEN",
    resolutionSource: null,
    resolutionCriteria: null,
    openTime: null,
    closeTime: null,
    resolutionTime: null,
    maxExposure: null,
    createdById: "admin-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    category: { id: "cat-1", slug: "weather", name: "Weather" },
    outcomes: [
      { id: "o-yes", marketId: "market-1", key: "YES", label: "Yes", sortOrder: 0, createdAt: new Date().toISOString() },
      { id: "o-no", marketId: "market-1", key: "NO", label: "No", sortOrder: 1, createdAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

describe("MarketList", () => {
  it("shows a retry button and lets the user recover from a load failure", async () => {
    mockedApi.fetchMarkets.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce([market({})]);
    const user = userEvent.setup();
    renderWithQueryClient(<MarketList />);

    expect(await screen.findByText(/couldn't load markets/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("Will it rain?")).toBeInTheDocument();
  });

  it("shows an empty state when there are no markets at all", async () => {
    mockedApi.fetchMarkets.mockResolvedValue([]);
    renderWithQueryClient(<MarketList />);
    expect(await screen.findByText("No markets found")).toBeInTheDocument();
    expect(screen.getByText(/no markets available right now/i)).toBeInTheDocument();
  });

  it("filters client-side by status without re-fetching", async () => {
    mockedApi.fetchMarkets.mockResolvedValue([
      market({ id: "m-open", slug: "m-open", title: "Open market", status: "OPEN" }),
      market({ id: "m-closed", slug: "m-closed", title: "Closed market", status: "CLOSED" }),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<MarketList />);

    await waitFor(() => expect(screen.getByText("Open market")).toBeInTheDocument());
    expect(screen.getByText("Closed market")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Open" }));
    expect(screen.getByText("Open market")).toBeInTheDocument();
    expect(screen.queryByText("Closed market")).not.toBeInTheDocument();

    // Only ever fetched once — the tab click filters the already-cached response.
    expect(mockedApi.fetchMarkets).toHaveBeenCalledTimes(1);
  });

  it("shows a filtered-empty message distinct from the no-markets-at-all message", async () => {
    mockedApi.fetchMarkets.mockResolvedValue([market({ status: "OPEN" })]);
    const user = userEvent.setup();
    renderWithQueryClient(<MarketList />);

    await waitFor(() => expect(screen.getByText("Will it rain?")).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Resolved" }));

    expect(await screen.findByText("No markets found")).toBeInTheDocument();
    expect(screen.getByText(/no markets match this filter/i)).toBeInTheDocument();
  });
});
