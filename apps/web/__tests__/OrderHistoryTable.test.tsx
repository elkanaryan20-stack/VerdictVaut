import type { Order } from "@verdictvaut/shared-types";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrderHistoryTable } from "../components/trading/OrderHistoryTable";
import { renderWithQueryClient } from "../test-support/render";
import * as tradingApi from "../lib/trading/api";

jest.mock("../lib/trading/api");
const mockedApi = tradingApi as jest.Mocked<typeof tradingApi>;

function order(overrides: Partial<Order>): Order {
  return {
    id: "order-1",
    userId: "user-1",
    marketId: "market-1",
    outcomeId: "outcome-1",
    side: "BUY",
    type: "LIMIT",
    price: "0.5",
    quantity: "10",
    filledQuantity: "10",
    remainingQuantity: "0",
    status: "FILLED",
    clientOrderId: "coid-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    market: { id: "market-1", slug: "will-it-rain", title: "Will it rain?", status: "OPEN", closeTime: null },
    outcome: { id: "outcome-1", marketId: "market-1", key: "YES", label: "Yes", sortOrder: 0, createdAt: new Date().toISOString() },
    ...overrides,
  };
}

describe("OrderHistoryTable", () => {
  it("shows an empty state when no orders match the filter", async () => {
    mockedApi.fetchMyOrders.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    renderWithQueryClient(<OrderHistoryTable />);
    expect(await screen.findByText("No orders match this filter.")).toBeInTheDocument();
  });

  it("shows market, outcome, and fill progress for a historical order", async () => {
    mockedApi.fetchMyOrders.mockResolvedValue({ items: [order({})], total: 1, page: 1, pageSize: 10 });
    renderWithQueryClient(<OrderHistoryTable />);
    expect(await screen.findByText("Will it rain?")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText(/10 of 10 filled/)).toBeInTheDocument();
  });

  it("refetches with the selected status filter", async () => {
    mockedApi.fetchMyOrders.mockResolvedValue({ items: [order({})], total: 1, page: 1, pageSize: 10 });
    const user = userEvent.setup();
    renderWithQueryClient(<OrderHistoryTable />);

    await screen.findByText("Will it rain?");
    await user.click(screen.getByRole("tab", { name: "Cancelled" }));

    expect(mockedApi.fetchMyOrders).toHaveBeenCalledWith(expect.objectContaining({ status: "CANCELLED", page: 1 }));
  });

  it("shows an error state on API failure", async () => {
    mockedApi.fetchMyOrders.mockRejectedValue(new Error("network down"));
    renderWithQueryClient(<OrderHistoryTable />);
    expect(await screen.findByText("Couldn't load your order history.")).toBeInTheDocument();
  });
});
