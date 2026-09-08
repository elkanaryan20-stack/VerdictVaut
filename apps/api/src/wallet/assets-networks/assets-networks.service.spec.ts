import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AssetsNetworksService } from "./assets-networks.service";

/**
 * Phase 11 finding: creating/activating a non-native AssetNetwork with no
 * contractAddress previously only failed later, at deposit-watcher scan
 * time (each chain adapter's own validateNetwork throws there) — much
 * less actionable than rejecting it immediately at config time.
 */
describe("AssetsNetworksService — non-native contractAddress validation", () => {
  let prisma: {
    asset: { findUnique: jest.Mock };
    network: { findUnique: jest.Mock };
    assetNetwork: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  };
  let service: AssetsNetworksService;

  beforeEach(() => {
    prisma = {
      asset: { findUnique: jest.fn().mockResolvedValue({ id: "asset-1", symbol: "USDC" }) },
      network: { findUnique: jest.fn().mockResolvedValue({ id: "network-1", code: "ethereum-sepolia" }) },
      assetNetwork: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    service = new AssetsNetworksService(prisma as never);
  });

  it("createAssetNetwork rejects a non-native asset/network with no contractAddress", async () => {
    await expect(
      service.createAssetNetwork({ assetSymbol: "USDC", networkCode: "ethereum-sepolia", isNative: false, minConfirmations: 12 }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.assetNetwork.create).not.toHaveBeenCalled();
  });

  it("createAssetNetwork allows a non-native asset/network WITH a contractAddress", async () => {
    prisma.assetNetwork.create.mockResolvedValue({ id: "an-1" });
    await service.createAssetNetwork({
      assetSymbol: "USDC",
      networkCode: "ethereum-sepolia",
      isNative: false,
      contractAddress: "0xcontract",
      minConfirmations: 12,
    });
    expect(prisma.assetNetwork.create).toHaveBeenCalled();
  });

  it("createAssetNetwork allows a native asset/network with no contractAddress", async () => {
    prisma.assetNetwork.create.mockResolvedValue({ id: "an-1" });
    await service.createAssetNetwork({ assetSymbol: "ETH", networkCode: "ethereum-sepolia", isNative: true, minConfirmations: 12 });
    expect(prisma.assetNetwork.create).toHaveBeenCalled();
  });

  it("setAssetNetworkActive(true) rejects a non-native asset/network with no contractAddress", async () => {
    prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isNative: false, contractAddress: null });
    await expect(service.setAssetNetworkActive("an-1", true)).rejects.toThrow(BadRequestException);
    expect(prisma.assetNetwork.update).not.toHaveBeenCalled();
  });

  it("setAssetNetworkActive(false) is always allowed, even when misconfigured (deactivating is never blocked)", async () => {
    prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isNative: false, contractAddress: null });
    prisma.assetNetwork.update.mockResolvedValue({ id: "an-1", isActive: false });
    await service.setAssetNetworkActive("an-1", false);
    expect(prisma.assetNetwork.update).toHaveBeenCalledWith({ where: { id: "an-1" }, data: { isActive: false } });
  });

  it("setAssetNetworkActive throws NotFoundException for an unknown id", async () => {
    prisma.assetNetwork.findUnique.mockResolvedValue(null);
    await expect(service.setAssetNetworkActive("missing", true)).rejects.toThrow(NotFoundException);
  });
});
