import type { AssetBalance, AssetNetworkView, Withdrawal } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WithdrawFlow } from "../components/wallet/WithdrawFlow";
import { renderWithQueryClient } from "../test-support/render";
import * as walletApi from "../lib/wallet/api";
import { ApiError } from "../lib/api-client";

jest.mock("../lib/wallet/api");
const mockedApi = walletApi as jest.Mocked<typeof walletApi>;

const usdcSepolia: AssetNetworkView = {
  id: "an-usdc-sepolia",
  assetId: "asset-usdc",
  networkId: "net-sepolia",
  isNative: false,
  contractAddress: "0xcontract",
  memoRequired: false,
  minConfirmations: 12,
  depositMinAmount: "0",
  withdrawalMinAmount: "10",
  isActive: true,
  asset: { id: "asset-usdc", symbol: "USDC", name: "USD Coin", decimals: 6, assetClass: "TOKEN", isSettlementCurrency: true, isActive: true },
  network: { id: "net-sepolia", code: "ethereum-sepolia", family: "EVM", environment: "SANDBOX", name: "Ethereum Sepolia", isActive: true },
};

const xrpTestnet: AssetNetworkView = {
  id: "an-xrp",
  assetId: "asset-xrp",
  networkId: "net-xrpl",
  isNative: true,
  contractAddress: null,
  memoRequired: true,
  minConfirmations: 1,
  depositMinAmount: "0",
  withdrawalMinAmount: "1",
  isActive: true,
  asset: { id: "asset-xrp", symbol: "XRP", name: "XRP", decimals: 6, assetClass: "NATIVE", isSettlementCurrency: false, isActive: true },
  network: { id: "net-xrpl", code: "xrpl-testnet", family: "XRPL", environment: "SANDBOX", name: "XRPL Testnet", isActive: true },
};

const usdcBalance: AssetBalance = {
  assetId: "asset-usdc",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  assetClass: "TOKEN",
  totalBalance: "100",
  reservedBalance: "0",
  availableBalance: "100",
};

function makeWithdrawal(overrides: Partial<Withdrawal> = {}): Withdrawal {
  return {
    id: "wd-1",
    userId: "user-1",
    assetNetworkId: "an-usdc-sepolia",
    destinationAddress: "0xDestination",
    destinationTag: null,
    amount: "25",
    fee: "0",
    status: "RISK_REVIEW",
    txHash: null,
    custodyReference: null,
    broadcastByAdminId: null,
    broadcastAt: null,
    confirmedAt: null,
    failureReason: null,
    complianceDecision: "DEFERRED",
    complianceNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  mockedApi.fetchAssetNetworks.mockResolvedValue([usdcSepolia, xrpTestnet]);
  mockedApi.fetchBalances.mockResolvedValue([usdcBalance]);
});

async function selectUsdcSepolia(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => screen.getByRole("radio", { name: /USDC/i }));
  await user.click(screen.getByRole("radio", { name: /USDC/i }));
  await user.click(await screen.findByRole("radio", { name: /Ethereum Sepolia/i }));
}

describe("WithdrawFlow", () => {
  it("shows the destination-tag field only for a network that requires one", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WithdrawFlow />);

    await waitFor(() => screen.getByRole("radio", { name: /XRP/i }));
    await user.click(screen.getByRole("radio", { name: /XRP/i }));
    await user.click(await screen.findByRole("radio", { name: /XRPL Testnet/i }));

    expect(await screen.findByLabelText("Destination tag / memo")).toBeInTheDocument();
  });

  it("never shows the destination-tag field for a network that doesn't require one", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WithdrawFlow />);
    await selectUsdcSepolia(user);

    expect(await screen.findByLabelText("Destination address")).toBeInTheDocument();
    expect(screen.queryByLabelText("Destination tag / memo")).not.toBeInTheDocument();
  });

  it("shows the user's real available balance for the selected asset, never a fabricated figure", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WithdrawFlow />);
    await selectUsdcSepolia(user);

    expect(await screen.findByText(/Available:/)).toBeInTheDocument();
    expect(screen.getByText(/100 USDC/)).toBeInTheDocument();
  });

  it("blocks review with a local validation error when the amount exceeds available balance, without calling the backend", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WithdrawFlow />);
    await selectUsdcSepolia(user);

    await user.type(await screen.findByLabelText("Destination address"), "0xSomeDestinationAddress");
    await user.type(screen.getByLabelText(/Amount/), "500");
    await user.click(screen.getByRole("button", { name: "Review withdrawal" }));

    expect(await screen.findByText(/exceeds your available balance/i)).toBeInTheDocument();
    expect(mockedApi.requestWithdrawal).not.toHaveBeenCalled();
  });

  it("blocks review when the amount is at or below the network's minimum withdrawal", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WithdrawFlow />);
    await selectUsdcSepolia(user);

    await user.type(await screen.findByLabelText("Destination address"), "0xSomeDestinationAddress");
    await user.type(screen.getByLabelText(/Amount/), "5");
    await user.click(screen.getByRole("button", { name: "Review withdrawal" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/minimum withdrawal/i);
    expect(mockedApi.requestWithdrawal).not.toHaveBeenCalled();
  });

  it("shows a confirmation dialog with the exact entered details before submitting anything", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<WithdrawFlow />);
    await selectUsdcSepolia(user);

    await user.type(await screen.findByLabelText("Destination address"), "0xSomeDestinationAddress");
    await user.type(screen.getByLabelText(/Amount/), "25");
    await user.click(screen.getByRole("button", { name: "Review withdrawal" }));

    expect(await screen.findByRole("heading", { name: "Confirm withdrawal" })).toBeInTheDocument();
    expect(screen.getByText("0xSomeDestinationAddress")).toBeInTheDocument();
    expect(mockedApi.requestWithdrawal).not.toHaveBeenCalled();
  });

  it("only calls requestWithdrawal once the confirmation dialog itself is confirmed, and shows the real backend-returned status afterward", async () => {
    mockedApi.requestWithdrawal.mockResolvedValue(makeWithdrawal());
    const user = userEvent.setup();
    renderWithQueryClient(<WithdrawFlow />);
    await selectUsdcSepolia(user);

    await user.type(await screen.findByLabelText("Destination address"), "0xSomeDestinationAddress");
    await user.type(screen.getByLabelText(/Amount/), "25");
    await user.click(screen.getByRole("button", { name: "Review withdrawal" }));
    await user.click(await screen.findByRole("button", { name: "Confirm withdrawal" }));

    expect(mockedApi.requestWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ assetSymbol: "USDC", networkCode: "ethereum-sepolia", amount: "25", destinationAddress: "0xSomeDestinationAddress" }),
    );
    expect(await screen.findByText("Withdrawal submitted")).toBeInTheDocument();
    expect(screen.getAllByText("Pending review").length).toBeGreaterThan(0);
  });

  it("shows the backend's rejection reason in the dialog on failure, without pretending success", async () => {
    mockedApi.requestWithdrawal.mockRejectedValue(new ApiError(422, "Amount exceeds available balance"));
    const user = userEvent.setup();
    renderWithQueryClient(<WithdrawFlow />);
    await selectUsdcSepolia(user);

    await user.type(await screen.findByLabelText("Destination address"), "0xSomeDestinationAddress");
    await user.type(screen.getByLabelText(/Amount/), "25");
    await user.click(screen.getByRole("button", { name: "Review withdrawal" }));
    await user.click(await screen.findByRole("button", { name: "Confirm withdrawal" }));

    expect(await screen.findByText("Amount exceeds available balance")).toBeInTheDocument();
    expect(screen.queryByText("Withdrawal submitted")).not.toBeInTheDocument();
  });
});
