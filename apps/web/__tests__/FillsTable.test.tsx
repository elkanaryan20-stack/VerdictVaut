import type { Fill, Market } from "@verdictvaut/shared-types";
import { screen } from "@testing-library/react";
import { FillsTable } from "../components/trading/FillsTable";
import { renderWithQueryClient } from "../test-support/render";
import * as tradingApi from "../lib/trading/api";

jest.mock("../lib/trading/api");
const mockedApi = tradingApi as jest.Mocked<typeof tradingApi>;

function fill(overrides: Partial<Fill>): Fill {
  return {
    fillId: "fill-1",
    marketId: "market-1",
    outcomeId: "outcome-1",
    orderId: "order-1",
    side: "BUY",
    isMaker: false,
    price: "0.55",
    quantity: "5",
    fee: "0",
    executedAt: new Date().toISOString(),
    ...overrides,
  };
}

function market(): Market {
  return {
    id: "market-1",
    slug: "will-it-rain",
    title: "Will it rain?",
    description: "",
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
    outcomes: [{ id: "outcome-1", marketId: "market-1", key: "YES", label: "Yes", sortOrder: 0, createdAt: new Date().toISOString() }],
  };
}

describe("FillsTable", () => {
  it("shows an empty state when the user has no fills", async () => {
    mockedApi.fetchMyFills.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    mockedApi.fetchMarkets.mockResolvedValue([]);
    renderWithQueryClient(<FillsTable />);
    expect(await screen.findByText("You have no fills yet.")).toBeInTheDocument();
  });

  it("resolves the market and outcome label for a fill from the markets list", async () => {
    mockedApi.fetchMyFills.mockResolvedValue({ items: [fill({})], total: 1, page: 1, pageSize: 10 });
    mockedApi.fetchMarkets.mockResolvedValue([market()]);

    renderWithQueryClient(<FillsTable />);

    expect(await screen.findByText("Will it rain?")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("falls back to the raw market id when the market can't be resolved", async () => {
    mockedApi.fetchMyFills.mockResolvedValue({ items: [fill({})], total: 1, page: 1, pageSize: 10 });
    mockedApi.fetchMarkets.mockResolvedValue([]);

    renderWithQueryClient(<FillsTable />);

    expect(await screen.findByText("market-1")).toBeInTheDocument();
  });

  it("shows an error state on API failure", async () => {
    mockedApi.fetchMyFills.mockRejectedValue(new Error("network down"));
    mockedApi.fetchMarkets.mockResolvedValue([]);
    renderWithQueryClient(<FillsTable />);
    expect(await screen.findByText("Couldn't load your fills.")).toBeInTheDocument();
  });
});
