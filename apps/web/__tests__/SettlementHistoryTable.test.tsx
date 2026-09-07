import type { Position, PositionSettlement } from "@verdictvaut/shared-types";
import { screen } from "@testing-library/react";
import { SettlementHistoryTable } from "../components/trading/SettlementHistoryTable";
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
    quantity: "0",
    reservedQuantity: "0",
    avgPrice: "0.5",
    realizedPnl: "0",
    settledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outcome: {
      id: "outcome-1",
      marketId: "market-1",
      key: "YES",
      label: "Yes",
      sortOrder: 0,
      createdAt: new Date().toISOString(),
      market: { id: "market-1", slug: "will-it-rain", title: "Will it rain?", status: "RESOLVED", closeTime: null },
    },
    ...overrides,
  };
}

function settlement(overrides: Partial<PositionSettlement>): PositionSettlement {
  return {
    id: "settlement-1",
    positionId: "position-1",
    marketId: "market-1",
    outcomeId: "outcome-1",
    userId: "user-1",
    quantity: "10",
    payoutPerShare: "1",
    payoutAmount: "10",
    ledgerTransactionId: "ledger-tx-abc123",
    idempotencyKey: "settlement:position-1",
    settledAt: new Date().toISOString(),
    outcome: { id: "outcome-1", key: "YES", label: "Yes" },
    ...overrides,
  };
}

describe("SettlementHistoryTable", () => {
  it("shows an empty state when the user has no settled positions", async () => {
    mockedApi.fetchMyPositions.mockResolvedValue([]);
    renderWithQueryClient(<SettlementHistoryTable />);
    expect(await screen.findByText("No settled positions yet.")).toBeInTheDocument();
    expect(mockedApi.fetchMySettlement).not.toHaveBeenCalled();
  });

  it("does not include still-open (unsettled) positions", async () => {
    mockedApi.fetchMyPositions.mockResolvedValue([position({ settledAt: null })]);
    renderWithQueryClient(<SettlementHistoryTable />);
    expect(await screen.findByText("No settled positions yet.")).toBeInTheDocument();
    expect(mockedApi.fetchMySettlement).not.toHaveBeenCalled();
  });

  it("shows a paid-out settlement with the exact backend payout amount", async () => {
    mockedApi.fetchMyPositions.mockResolvedValue([position({})]);
    mockedApi.fetchMySettlement.mockResolvedValue([settlement({})]);

    renderWithQueryClient(<SettlementHistoryTable />);

    expect(await screen.findByText("Will it rain?")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("Paid out")).toBeInTheDocument();
  });

  it("correctly represents a zero-payout (losing) settlement without fabricating a payout", async () => {
    mockedApi.fetchMyPositions.mockResolvedValue([position({})]);
    mockedApi.fetchMySettlement.mockResolvedValue([
      settlement({ payoutAmount: "0", payoutPerShare: "0", ledgerTransactionId: null }),
    ]);

    renderWithQueryClient(<SettlementHistoryTable />);

    expect(await screen.findByText("No payout")).toBeInTheDocument();
    expect(screen.queryByText(/ledger ref/i)).not.toBeInTheDocument();
  });

  it("shows an error state and retries on demand instead of showing a fabricated zero", async () => {
    mockedApi.fetchMyPositions.mockRejectedValue(new Error("network down"));

    renderWithQueryClient(<SettlementHistoryTable />);

    expect(await screen.findByText("Couldn't load your settlement history.")).toBeInTheDocument();
    expect(screen.queryByText("No settled positions yet.")).not.toBeInTheDocument();
  });

  it("still shows successfully-loaded settlements when another market's settlement fetch fails", async () => {
    mockedApi.fetchMyPositions.mockResolvedValue([
      position({ id: "position-1", marketId: "market-1" }),
      position({
        id: "position-2",
        marketId: "market-2",
        outcome: {
          id: "outcome-2",
          marketId: "market-2",
          key: "NO",
          label: "No",
          sortOrder: 0,
          createdAt: new Date().toISOString(),
          market: { id: "market-2", slug: "market-two", title: "Will it snow?", status: "RESOLVED", closeTime: null },
        },
      }),
    ]);
    mockedApi.fetchMySettlement.mockImplementation(async (marketId) => {
      if (marketId === "market-2") throw new Error("network down");
      return [settlement({})];
    });

    renderWithQueryClient(<SettlementHistoryTable />);

    expect(await screen.findByText("Will it rain?")).toBeInTheDocument();
    expect(screen.getByText(/Some settlement data couldn't be loaded/)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your settlement history.")).not.toBeInTheDocument();
  });

  it("keeps a stable order for settlements with identical settledAt timestamps", async () => {
    const sameInstant = new Date("2026-01-01T00:00:00Z").toISOString();
    mockedApi.fetchMyPositions.mockResolvedValue([
      position({ id: "position-1", marketId: "market-1", settledAt: sameInstant }),
      position({
        id: "position-2",
        marketId: "market-2",
        settledAt: sameInstant,
        outcome: {
          id: "outcome-2",
          marketId: "market-2",
          key: "NO",
          label: "No",
          sortOrder: 0,
          createdAt: new Date().toISOString(),
          market: { id: "market-2", slug: "market-two", title: "Will it snow?", status: "RESOLVED", closeTime: null },
        },
      }),
    ]);
    mockedApi.fetchMySettlement.mockImplementation(async (marketId) => [
      settlement({ id: `settlement-${marketId}`, marketId, settledAt: sameInstant }),
    ]);

    renderWithQueryClient(<SettlementHistoryTable />);

    expect(await screen.findByText("Will it rain?")).toBeInTheDocument();
    expect(screen.getByText("Will it snow?")).toBeInTheDocument();
  });
});
