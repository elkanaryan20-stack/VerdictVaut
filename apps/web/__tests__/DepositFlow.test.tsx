import type { AssetNetworkView, DepositAddressAssignment } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DepositFlow } from "../components/wallet/DepositFlow";
import { renderWithQueryClient } from "../test-support/render";
import * as walletApi from "../lib/wallet/api";

jest.mock("../lib/wallet/api");
const mockedApi = walletApi as jest.Mocked<typeof walletApi>;

function assetNetwork(overrides: Partial<AssetNetworkView>): AssetNetworkView {
  return {
    id: "an-usdc-sepolia",
    assetId: "asset-usdc",
    networkId: "net-sepolia",
    isNative: false,
    contractAddress: "0xcontract",
    memoRequired: false,
    minConfirmations: 12,
    depositMinAmount: "0",
    withdrawalMinAmount: "0",
    isActive: true,
    asset: { id: "asset-usdc", symbol: "USDC", name: "USD Coin", decimals: 6, assetClass: "TOKEN", isSettlementCurrency: true, isActive: true },
    network: { id: "net-sepolia", code: "ethereum-sepolia", family: "EVM", environment: "SANDBOX", name: "Ethereum Sepolia", isActive: true },
    ...overrides,
  };
}

const usdcSepolia = assetNetwork({});
const usdcBase = assetNetwork({
  id: "an-usdc-base",
  networkId: "net-base",
  network: { id: "net-base", code: "base-sepolia", family: "EVM", environment: "SANDBOX", name: "Base Sepolia", isActive: true },
});
const xrpTestnet = assetNetwork({
  id: "an-xrp",
  assetId: "asset-xrp",
  networkId: "net-xrpl",
  isNative: true,
  contractAddress: null,
  memoRequired: true,
  minConfirmations: 1,
  asset: { id: "asset-xrp", symbol: "XRP", name: "XRP", decimals: 6, assetClass: "NATIVE", isSettlementCurrency: false, isActive: true },
  network: { id: "net-xrpl", code: "xrpl-testnet", family: "XRPL", environment: "SANDBOX", name: "XRPL Testnet", isActive: true },
});

beforeEach(() => {
  mockedApi.fetchAssetNetworks.mockResolvedValue([usdcSepolia, usdcBase, xrpTestnet]);
});

describe("DepositFlow", () => {
  it("lists each distinct asset exactly once for selection", async () => {
    renderWithQueryClient(<DepositFlow />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /USDC/i })).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: /XRP/i })).toBeInTheDocument();
    expect(screen.getAllByRole("radio", { name: /USDC/i })).toHaveLength(1);
  });

  it("shows network options only for the selected asset, preserving both asset and network as distinct choices (USDC on two different networks)", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<DepositFlow />);

    await waitFor(() => screen.getByRole("radio", { name: /USDC/i }));
    await user.click(screen.getByRole("radio", { name: /USDC/i }));

    expect(await screen.findByText("Ethereum Sepolia")).toBeInTheDocument();
    expect(screen.getByText("Base Sepolia")).toBeInTheDocument();
    // XRPL Testnet must not appear as a network option for USDC.
    expect(screen.queryByText("XRPL Testnet")).not.toBeInTheDocument();
  });

  it("requests a deposit address with BOTH the selected asset and network, never one alone", async () => {
    mockedApi.assignDepositAddress.mockResolvedValue({
      id: "assign-1",
      userId: "user-1",
      assetId: "asset-usdc",
      networkId: "net-base",
      assetNetworkId: "an-usdc-base",
      walletAddressId: "wa-1",
      destinationTag: null,
      environment: "SANDBOX",
      assignedAt: new Date().toISOString(),
      walletAddress: { id: "wa-1", address: "0xBaseAddress", destinationTag: null, environment: "SANDBOX" },
    });

    const user = userEvent.setup();
    renderWithQueryClient(<DepositFlow />);

    await waitFor(() => screen.getByRole("radio", { name: /USDC/i }));
    await user.click(screen.getByRole("radio", { name: /USDC/i }));
    await user.click(await screen.findByText("Base Sepolia"));

    await waitFor(() => expect(mockedApi.assignDepositAddress).toHaveBeenCalledWith("USDC", "base-sepolia"));
    expect(await screen.findByText("0xBaseAddress")).toBeInTheDocument();
  });

  it("pre-selects the asset passed in via initialAsset", async () => {
    renderWithQueryClient(<DepositFlow initialAsset="XRP" />);
    await waitFor(() => expect(screen.getByText("XRPL Testnet")).toBeInTheDocument());
  });

  it("never displays a stale/mismatched address when the user switches networks before the first request resolves out of order", async () => {
    // Simulates the first-selected network (Sepolia) resolving AFTER the
    // second-selected one (Base) — a real possibility with two
    // independent in-flight requests. The UI must end up showing Base's
    // address, matching what's actually selected, never Sepolia's.
    let resolveSepolia!: (value: DepositAddressAssignment) => void;
    mockedApi.assignDepositAddress.mockImplementation((assetSymbol, networkCode) => {
      if (networkCode === "ethereum-sepolia") {
        return new Promise<DepositAddressAssignment>((resolve) => {
          resolveSepolia = resolve;
        });
      }
      return Promise.resolve({
        id: "assign-base",
        userId: "user-1",
        assetId: "asset-usdc",
        networkId: "net-base",
        assetNetworkId: "an-usdc-base",
        walletAddressId: "wa-base",
        destinationTag: null,
        environment: "SANDBOX" as const,
        assignedAt: new Date().toISOString(),
        walletAddress: { id: "wa-base", address: "0xBaseAddress", destinationTag: null, environment: "SANDBOX" as const },
      });
    });

    const user = userEvent.setup();
    renderWithQueryClient(<DepositFlow />);

    await waitFor(() => screen.getByRole("radio", { name: /USDC/i }));
    await user.click(screen.getByRole("radio", { name: /USDC/i }));

    // Select Sepolia first (kicks off its still-pending request), then
    // switch to Base before Sepolia's request has resolved.
    await user.click(await screen.findByText("Ethereum Sepolia"));
    await user.click(screen.getByText("Base Sepolia"));

    // Base's address (the actual current selection) appears.
    expect(await screen.findByText("0xBaseAddress")).toBeInTheDocument();

    // NOW the stale Sepolia request finally resolves. It must not
    // retroactively replace what's displayed for Base.
    resolveSepolia({
      id: "assign-sepolia",
      userId: "user-1",
      assetId: "asset-usdc",
      networkId: "net-sepolia",
      assetNetworkId: "an-usdc-sepolia",
      walletAddressId: "wa-sepolia",
      destinationTag: null,
      environment: "SANDBOX",
      assignedAt: new Date().toISOString(),
      walletAddress: { id: "wa-sepolia", address: "0xSepoliaAddress", destinationTag: null, environment: "SANDBOX" },
    });

    // Give the stale promise a chance to settle and flow through React Query.
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText("0xBaseAddress")).toBeInTheDocument();
    expect(screen.queryByText("0xSepoliaAddress")).not.toBeInTheDocument();
  });
});
