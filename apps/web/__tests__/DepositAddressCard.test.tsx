import type { AssetNetworkView, DepositAddressAssignment } from "@verdictvaut/shared-types";
import { render, screen } from "@testing-library/react";
import { DepositAddressCard } from "../components/wallet/DepositAddressCard";

const baseAssetNetwork: AssetNetworkView = {
  id: "an-1",
  assetId: "asset-1",
  networkId: "net-1",
  isNative: true,
  contractAddress: null,
  memoRequired: false,
  minConfirmations: 12,
  depositMinAmount: "0",
  withdrawalMinAmount: "0",
  isActive: true,
  asset: { id: "asset-1", symbol: "ETH", name: "Ethereum", decimals: 18, assetClass: "NATIVE", isSettlementCurrency: false, isActive: true },
  network: { id: "net-1", code: "ethereum-sepolia", family: "EVM", environment: "SANDBOX", name: "Ethereum Sepolia", isActive: true },
};

function makeAssignment(overrides: Partial<DepositAddressAssignment["walletAddress"]> = {}): DepositAddressAssignment {
  return {
    id: "assign-1",
    userId: "user-1",
    assetId: "asset-1",
    networkId: "net-1",
    assetNetworkId: "an-1",
    walletAddressId: "wa-1",
    destinationTag: overrides.destinationTag ?? null,
    environment: "SANDBOX",
    assignedAt: new Date().toISOString(),
    walletAddress: {
      id: "wa-1",
      address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976",
      destinationTag: null,
      environment: "SANDBOX",
      ...overrides,
    },
  };
}

describe("DepositAddressCard", () => {
  it("renders the deposit address", () => {
    render(<DepositAddressCard assignment={makeAssignment()} assetNetwork={baseAssetNetwork} />);
    expect(screen.getByText("0x71C7656EC7ab88b098defB751B7401B5f6d8976")).toBeInTheDocument();
  });

  it("never shows a destination tag section when the address doesn't have one", () => {
    render(<DepositAddressCard assignment={makeAssignment()} assetNetwork={baseAssetNetwork} />);
    expect(screen.queryByText("Destination tag required")).not.toBeInTheDocument();
  });

  it("prominently displays the destination tag, separately from the address, when one is required (e.g. XRP)", () => {
    const xrpAssetNetwork: AssetNetworkView = {
      ...baseAssetNetwork,
      memoRequired: true,
      asset: { ...baseAssetNetwork.asset, symbol: "XRP", name: "XRP" },
      network: { ...baseAssetNetwork.network, code: "xrpl-testnet", family: "XRPL", name: "XRPL Testnet" },
    };
    const assignment = makeAssignment({ address: "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh", destinationTag: "104598917" });

    render(<DepositAddressCard assignment={assignment} assetNetwork={xrpAssetNetwork} />);

    expect(screen.getByText("Destination tag required")).toBeInTheDocument();
    expect(screen.getByText("104598917")).toBeInTheDocument();
    // The address and the tag must be two visually and structurally
    // separate values — never concatenated into one string.
    expect(screen.getByText("rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh")).toBeInTheDocument();
    expect(screen.getByText("rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh").textContent).not.toContain("104598917");
    // Two independent copy controls — one for the address, one for the tag.
    expect(screen.getAllByRole("button", { name: /copy/i }).length).toBeGreaterThanOrEqual(2);
  });
});
