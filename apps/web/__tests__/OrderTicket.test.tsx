import type { Market, MarketOutcome } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "../lib/api-client";
import { useAuth } from "../lib/auth/auth-context";
import { OrderTicket } from "../components/trading/OrderTicket";
import { renderWithQueryClient } from "../test-support/render";
import * as tradingApi from "../lib/trading/api";
import * as walletApi from "../lib/wallet/api";

jest.mock("../lib/auth/auth-context", () => ({ useAuth: jest.fn() }));
jest.mock("../lib/trading/api");
jest.mock("../lib/wallet/api");

const mockedUseAuth = useAuth as jest.Mock;
const mockedTradingApi = tradingApi as jest.Mocked<typeof tradingApi>;
const mockedWalletApi = walletApi as jest.Mocked<typeof walletApi>;

const market: Market = {
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
  outcomes: [],
};

const outcome: MarketOutcome = { id: "outcome-yes", marketId: "market-1", key: "YES", label: "Yes", sortOrder: 0, createdAt: new Date().toISOString() };

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ status: "authenticated", user: { id: "user-1", email: "a@b.com" } });
  mockedWalletApi.fetchBalances.mockResolvedValue([
    { assetId: "usdc", symbol: "USDC", name: "USD Coin", decimals: 6, assetClass: "TOKEN", totalBalance: "1000", reservedBalance: "0", availableBalance: "1000" },
  ]);
  mockedWalletApi.fetchAssetNetworks.mockResolvedValue([
    {
      id: "an-1",
      assetId: "usdc",
      networkId: "net-1",
      isNative: false,
      contractAddress: null,
      memoRequired: false,
      minConfirmations: 1,
      depositMinAmount: "0",
      withdrawalMinAmount: "0",
      isActive: true,
      asset: { id: "usdc", symbol: "USDC", name: "USD Coin", decimals: 6, assetClass: "TOKEN", isSettlementCurrency: true, isActive: true },
      network: { id: "net-1", code: "net-1", family: "EVM", environment: "SANDBOX", name: "Net 1", isActive: true },
    },
  ]);
});

async function fillAndGetSubmit(price: string, quantity: string) {
  const user = userEvent.setup();
  await screen.findByText(/available to spend/i);
  await user.type(screen.getByLabelText(/limit price/i), price);
  await user.type(screen.getByLabelText(/quantity/i), quantity);
  return { user, submit: () => screen.getByRole("button", { name: /^BUY Yes$/i }) };
}

describe("OrderTicket", () => {
  it("shows a login prompt and never fetches wallet balances when unauthenticated", () => {
    mockedUseAuth.mockReturnValue({ status: "unauthenticated", user: null });
    renderWithQueryClient(<OrderTicket market={market} outcome={outcome} position={null} />);

    expect(screen.getByText(/log in to place an order/i)).toBeInTheDocument();
    expect(mockedWalletApi.fetchBalances).not.toHaveBeenCalled();
  });

  it("hides the order form and explains why when the market isn't OPEN", () => {
    renderWithQueryClient(<OrderTicket market={{ ...market, status: "CLOSED" }} outcome={outcome} position={null} />);
    expect(screen.getByText(/trading is not available/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/limit price/i)).not.toBeInTheDocument();
  });

  it("shows the settlement-currency available balance derived from wallet asset-networks + balances", async () => {
    renderWithQueryClient(<OrderTicket market={market} outcome={outcome} position={null} />);
    expect(await screen.findByText(/1,000\s*USDC/)).toBeInTheDocument();
  });

  it("rejects an out-of-range price locally, before ever calling placeOrder", async () => {
    renderWithQueryClient(<OrderTicket market={market} outcome={outcome} position={null} />);
    const { user, submit } = await fillAndGetSubmit("1.5", "10");
    await user.click(submit());

    expect(await screen.findByText(/price must be less than 1/i)).toBeInTheDocument();
    expect(mockedTradingApi.placeOrder).not.toHaveBeenCalled();
  });

  it("places a BUY order and renders the resulting fill summary from the backend response", async () => {
    mockedTradingApi.placeOrder.mockResolvedValue({
      orderId: "order-1",
      status: "FILLED",
      side: "BUY",
      quantity: "10",
      filledQuantity: "10",
      remainingQuantity: "0",
      fills: [{ fillId: "fill-1", price: "0.5", quantity: "10", executedAt: new Date().toISOString() }],
      averageExecutionPrice: "0.5",
      reservedAmountRemaining: "0",
    });

    renderWithQueryClient(<OrderTicket market={market} outcome={outcome} position={null} />);
    const { user, submit } = await fillAndGetSubmit("0.5", "10");
    await user.click(submit());

    expect(await screen.findByText("Filled")).toBeInTheDocument();
    expect(screen.getByText(/filled 10 of 10/i)).toBeInTheDocument();
    expect(mockedTradingApi.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ marketId: "market-1", outcomeId: "outcome-yes", side: "BUY", type: "LIMIT", price: "0.5", quantity: "10" }),
    );
  });

  it("surfaces the backend's exact insufficient-funds message, never a generic error", async () => {
    mockedTradingApi.placeOrder.mockRejectedValue(new ApiError(400, "Insufficient available balance to complete this request."));

    renderWithQueryClient(<OrderTicket market={market} outcome={outcome} position={null} />);
    const { user, submit } = await fillAndGetSubmit("0.5", "10");
    await user.click(submit());

    expect(await screen.findByText("Insufficient available balance to complete this request.")).toBeInTheDocument();
  });

  it("disables the submit button while a submission is in flight, preventing a double submit", async () => {
    let resolvePlace!: (value: Awaited<ReturnType<typeof tradingApi.placeOrder>>) => void;
    mockedTradingApi.placeOrder.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePlace = resolve;
        }),
    );

    renderWithQueryClient(<OrderTicket market={market} outcome={outcome} position={null} />);
    const { user, submit } = await fillAndGetSubmit("0.5", "10");
    await user.click(submit());

    await waitFor(() => expect(screen.getByRole("button", { name: /placing order/i })).toBeDisabled());
    expect(mockedTradingApi.placeOrder).toHaveBeenCalledTimes(1);

    resolvePlace({
      orderId: "order-1",
      status: "OPEN",
      side: "BUY",
      quantity: "10",
      filledQuantity: "0",
      remainingQuantity: "10",
      fills: [],
      averageExecutionPrice: null,
      reservedAmountRemaining: "5",
    });
  });

  it("reuses the same clientOrderId across a retry with unchanged fields", async () => {
    mockedTradingApi.placeOrder.mockRejectedValue(new ApiError(400, "Insufficient available balance to complete this request."));

    renderWithQueryClient(<OrderTicket market={market} outcome={outcome} position={null} />);
    const { user, submit } = await fillAndGetSubmit("0.5", "10");
    await user.click(submit());
    await screen.findByText("Insufficient available balance to complete this request.");

    // Retry with the SAME fields — must reuse the same clientOrderId.
    await user.click(submit());
    await waitFor(() => expect(mockedTradingApi.placeOrder).toHaveBeenCalledTimes(2));
    const firstId = mockedTradingApi.placeOrder.mock.calls[0][0].clientOrderId;
    const secondId = mockedTradingApi.placeOrder.mock.calls[1][0].clientOrderId;
    expect(secondId).toBe(firstId);
  });

  it("issues a fresh clientOrderId once the user edits a field after a failed attempt", async () => {
    mockedTradingApi.placeOrder.mockRejectedValue(new ApiError(400, "Insufficient available balance to complete this request."));

    renderWithQueryClient(<OrderTicket market={market} outcome={outcome} position={null} />);
    const { user, submit } = await fillAndGetSubmit("0.5", "10");
    await user.click(submit());
    await screen.findByText("Insufficient available balance to complete this request.");

    // Editing quantity after a resolved (failed) attempt starts a new one.
    await user.clear(screen.getByLabelText(/quantity/i));
    await user.type(screen.getByLabelText(/quantity/i), "5");
    await user.click(submit());

    await waitFor(() => expect(mockedTradingApi.placeOrder).toHaveBeenCalledTimes(2));
    const firstId = mockedTradingApi.placeOrder.mock.calls[0][0].clientOrderId;
    const secondId = mockedTradingApi.placeOrder.mock.calls[1][0].clientOrderId;
    expect(secondId).not.toBe(firstId);
  });
});
