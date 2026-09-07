import type { Position } from "@verdictvaut/shared-types";
import { screen } from "@testing-library/react";
import { PositionsTable } from "../components/trading/PositionsTable";
import { renderWithQueryClient } from "../test-support/render";
import * as tradingApi from "../lib/trading/api";

jest.mock("../lib/trading/api");
const mockedApi = tradingApi as jest.Mocked<typeof tradingApi>;

function position(overrides: Partial<Position>): Position {
  return {
    id: "position-1",
    userId: "user-1",
    marketId: "market-1",
    outcomeId: "outcome-1",
    quantity: "25",
    reservedQuantity: "0",
    avgPrice: "0.42",
    realizedPnl: "0",
    settledAt: null,
    updatedAt: new Date().toISOString(),
    outcome: {
      id: "outcome-1",
      marketId: "market-1",
      key: "YES",
      label: "Yes",
      sortOrder: 0,
      createdAt: new Date().toISOString(),
      market: { id: "market-1", slug: "will-it-rain", title: "Will it rain?", status: "OPEN", closeTime: null },
    },
    ...overrides,
  };
}

describe("PositionsTable", () => {
  it("shows an empty state when the user has no positions", async () => {
    mockedApi.fetchMyPositions.mockResolvedValue([]);
    renderWithQueryClient(<PositionsTable />);
    expect(await screen.findByText("You have no positions.")).toBeInTheDocument();
  });

  it("shows an open position's quantity and average price using exact backend strings", async () => {
    mockedApi.fetchMyPositions.mockResolvedValue([position({})]);
    renderWithQueryClient(<PositionsTable />);
    expect(await screen.findByText("Will it rain?")).toBeInTheDocument();
    expect(screen.getByText("25")).toBeInTheDocument();
    expect(screen.getByText("Avg. price 0.42")).toBeInTheDocument();
  });

  it("marks a settled position distinctly instead of showing it as still open", async () => {
    mockedApi.fetchMyPositions.mockResolvedValue([position({ settledAt: new Date("2026-01-01T00:00:00Z").toISOString() })]);
    renderWithQueryClient(<PositionsTable />);
    expect(await screen.findByText(/Settled/)).toBeInTheDocument();
  });

  it("shows an error state instead of an empty or zeroed table on API failure", async () => {
    mockedApi.fetchMyPositions.mockRejectedValue(new Error("network down"));
    renderWithQueryClient(<PositionsTable />);
    expect(await screen.findByText("Couldn't load your positions.")).toBeInTheDocument();
    expect(screen.queryByText("You have no positions.")).not.toBeInTheDocument();
  });
});
