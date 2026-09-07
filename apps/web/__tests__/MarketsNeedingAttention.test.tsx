import type { Market, MarketResolutionStatus } from "@verdictvaut/shared-types";
import { screen } from "@testing-library/react";
import { MarketsNeedingAttention } from "../components/admin/MarketsNeedingAttention";
import { renderWithQueryClient } from "../test-support/render";
import * as tradingApi from "../lib/trading/api";

jest.mock("../lib/trading/api");
const mockedApi = tradingApi as jest.Mocked<typeof tradingApi>;

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: "market-1",
    slug: "will-it-rain",
    title: "Will it rain?",
    description: "",
    categoryId: "cat-1",
    status: "RESOLVING",
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
    outcomes: [],
    ...overrides,
  };
}

function resolutionStatus(overrides: Partial<MarketResolutionStatus> = {}): MarketResolutionStatus {
  return {
    marketId: "market-1",
    status: "RESOLVING",
    resolution: {
      winningOutcomeId: "outcome-1",
      winningOutcomeKey: "YES",
      resolverId: "admin-1",
      resolvedAt: new Date().toISOString(),
      settledAt: null,
      notes: null,
    },
    settlement: { settledPositions: 3, totalPositions: 10 },
    ...overrides,
  };
}

describe("MarketsNeedingAttention", () => {
  it("shows an empty state when no market is currently resolving", async () => {
    mockedApi.fetchMarkets.mockResolvedValue([]);
    renderWithQueryClient(<MarketsNeedingAttention />);
    expect(await screen.findByText("No markets are currently mid-settlement.")).toBeInTheDocument();
  });

  it("shows real settlement progress from the backend, never a fabricated figure", async () => {
    mockedApi.fetchMarkets.mockResolvedValue([market()]);
    mockedApi.fetchMarketResolutionStatus.mockResolvedValue(resolutionStatus());

    renderWithQueryClient(<MarketsNeedingAttention />);

    expect(await screen.findByText("Will it rain?")).toBeInTheDocument();
    expect(screen.getByText("3 of 10 settled")).toBeInTheDocument();
  });

  it("shows a partial-error notice instead of hiding markets whose resolution status did load", async () => {
    mockedApi.fetchMarkets.mockResolvedValue([market({ id: "m1", slug: "m1" }), market({ id: "m2", slug: "m2", title: "Second market" })]);
    mockedApi.fetchMarketResolutionStatus.mockImplementation(async (marketId) => {
      if (marketId === "m2") throw new Error("boom");
      return resolutionStatus({ marketId: "m1" });
    });

    renderWithQueryClient(<MarketsNeedingAttention />);

    expect(await screen.findByText("3 of 10 settled")).toBeInTheDocument();
    expect(screen.getByText(/couldn't be loaded/i)).toBeInTheDocument();
  });

  it("shows an error state when the market list itself fails to load", async () => {
    mockedApi.fetchMarkets.mockRejectedValue(new Error("network down"));
    renderWithQueryClient(<MarketsNeedingAttention />);
    expect(await screen.findByText("Couldn't load resolving markets.")).toBeInTheDocument();
  });
});
