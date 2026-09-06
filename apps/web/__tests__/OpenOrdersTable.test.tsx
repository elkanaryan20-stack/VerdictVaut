import type { Order } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../lib/api-client";
import { OpenOrdersTable } from "../components/trading/OpenOrdersTable";
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
    filledQuantity: "0",
    remainingQuantity: "10",
    status: "OPEN",
    clientOrderId: "coid-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    market: { id: "market-1", slug: "market-1", title: "Will it rain?", status: "OPEN", closeTime: null },
    ...overrides,
  };
}

describe("OpenOrdersTable", () => {
  it("merges OPEN and PARTIALLY_FILLED orders from the two separate backend queries", async () => {
    mockedApi.fetchMyOrders.mockImplementation(async (options) => {
      if (options?.status === "OPEN") {
        return { items: [order({ id: "open-1" })], total: 1, page: 1, pageSize: 50 };
      }
      return { items: [order({ id: "partial-1", status: "PARTIALLY_FILLED", filledQuantity: "3", remainingQuantity: "7" })], total: 1, page: 1, pageSize: 50 };
    });

    renderWithQueryClient(<OpenOrdersTable />);

    expect(await screen.findByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Partially filled")).toBeInTheDocument();
  });

  it("shows an empty state when there are no open orders", async () => {
    mockedApi.fetchMyOrders.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 50 });
    renderWithQueryClient(<OpenOrdersTable />);
    expect(await screen.findByText("You have no open orders.")).toBeInTheDocument();
  });

  it("only shows a Cancel button for cancellable orders", async () => {
    mockedApi.fetchMyOrders.mockImplementation(async (options) => {
      if (options?.status === "OPEN") return { items: [order({ id: "open-1" })], total: 1, page: 1, pageSize: 50 };
      return { items: [], total: 0, page: 1, pageSize: 50 };
    });
    renderWithQueryClient(<OpenOrdersTable />);
    expect(await screen.findByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("cancels an order and surfaces a race-condition error without crashing", async () => {
    mockedApi.fetchMyOrders.mockImplementation(async (options) => {
      if (options?.status === "OPEN") return { items: [order({ id: "open-1" })], total: 1, page: 1, pageSize: 50 };
      return { items: [], total: 0, page: 1, pageSize: 50 };
    });
    mockedApi.cancelOrder.mockRejectedValue(new ApiError(400, "Cannot cancel an order in status FILLED"));

    const user = userEvent.setup();
    renderWithQueryClient(<OpenOrdersTable />);

    const cancelButton = await screen.findByRole("button", { name: /cancel/i });
    await user.click(cancelButton);

    expect(await screen.findByText("Cannot cancel an order in status FILLED")).toBeInTheDocument();
  });

  it("calls cancelOrder with the order id on click", async () => {
    mockedApi.fetchMyOrders.mockImplementation(async (options) => {
      if (options?.status === "OPEN") return { items: [order({ id: "open-1" })], total: 1, page: 1, pageSize: 50 };
      return { items: [], total: 0, page: 1, pageSize: 50 };
    });
    mockedApi.cancelOrder.mockResolvedValue(order({ id: "open-1", status: "CANCELLED" }));

    const user = userEvent.setup();
    renderWithQueryClient(<OpenOrdersTable />);

    const cancelButton = await screen.findByRole("button", { name: /cancel/i });
    await user.click(cancelButton);

    await waitFor(() => expect(mockedApi.cancelOrder).toHaveBeenCalledWith("open-1"));
  });
});
