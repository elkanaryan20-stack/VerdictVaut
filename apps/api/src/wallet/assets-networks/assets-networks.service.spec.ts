import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ChainRpcConfigService } from "../chain-adapters/rpc-config.service";
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
      network: { findUnique: jest.fn().mockResolvedValue({ id: "network-1", code: "ethereum-sepolia", environment: "SANDBOX" }) },
      assetNetwork: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    // A real ChainRpcConfigService, not a mock — it's pure/deterministic
    // (no network I/O; it only resolves a URL string), and
    // "ethereum-sepolia" already resolves via its own sandbox defaults,
    // so this exercises the genuine reachability check.
    service = new AssetsNetworksService(prisma as never, new ChainRpcConfigService(), { get: () => "sandbox" } as never);
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
    prisma.assetNetwork.findUnique.mockResolvedValue({
      id: "an-1",
      isNative: false,
      contractAddress: null,
      network: { code: "ethereum-sepolia", environment: "SANDBOX" },
    });
    await expect(service.setAssetNetworkActive("an-1", true)).rejects.toThrow(BadRequestException);
    expect(prisma.assetNetwork.update).not.toHaveBeenCalled();
  });

  it("setAssetNetworkActive(false) is always allowed, even when misconfigured (deactivating is never blocked)", async () => {
    prisma.assetNetwork.findUnique.mockResolvedValue({
      id: "an-1",
      isNative: false,
      contractAddress: null,
      network: { code: "ethereum-sepolia", environment: "SANDBOX" },
    });
    prisma.assetNetwork.update.mockResolvedValue({ id: "an-1", isActive: false });
    await service.setAssetNetworkActive("an-1", false);
    expect(prisma.assetNetwork.update).toHaveBeenCalledWith({ where: { id: "an-1" }, data: { isActive: false } });
  });

  it("setAssetNetworkActive throws NotFoundException for an unknown id", async () => {
    prisma.assetNetwork.findUnique.mockResolvedValue(null);
    await expect(service.setAssetNetworkActive("missing", true)).rejects.toThrow(NotFoundException);
  });

  describe("watcher configuration completeness (Phase 14A, section 5)", () => {
    it("rejects activation when the network has no resolvable RPC/provider URL configured", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({
        id: "an-1",
        isNative: true,
        contractAddress: null,
        network: { code: "some-unconfigured-network", environment: "SANDBOX" },
      });
      await expect(service.setAssetNetworkActive("an-1", true)).rejects.toThrow(BadRequestException);
      expect(prisma.assetNetwork.update).not.toHaveBeenCalled();
    });

    it("allows activation when the network resolves via its sandbox default RPC URL", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({
        id: "an-1",
        isNative: true,
        contractAddress: null,
        network: { code: "ethereum-sepolia", environment: "SANDBOX" },
      });
      prisma.assetNetwork.update.mockResolvedValue({ id: "an-1", isActive: true });
      await service.setAssetNetworkActive("an-1", true);
      expect(prisma.assetNetwork.update).toHaveBeenCalledWith({ where: { id: "an-1" }, data: { isActive: true } });
    });

    it("never checks RPC reachability when deactivating — an unconfigured network can always be turned off", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({
        id: "an-1",
        isNative: true,
        contractAddress: null,
        network: { code: "some-unconfigured-network", environment: "SANDBOX" },
      });
      prisma.assetNetwork.update.mockResolvedValue({ id: "an-1", isActive: false });
      await service.setAssetNetworkActive("an-1", false);
      expect(prisma.assetNetwork.update).toHaveBeenCalledWith({ where: { id: "an-1" }, data: { isActive: false } });
    });
  });

  describe("network environment must match APP_ENVIRONMENT (Phase 40)", () => {
    const productionService = () => new AssetsNetworksService(prisma as never, new ChainRpcConfigService(), { get: () => "production" } as never);

    it("a sandbox deployment refuses to activate an asset on a PRODUCTION (mainnet) network", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isNative: true, contractAddress: null, network: { code: "ethereum-mainnet", environment: "PRODUCTION" } });
      await expect(service.setAssetNetworkActive("an-1", true)).rejects.toThrow(/may only enable SANDBOX networks/);
      expect(prisma.assetNetwork.update).not.toHaveBeenCalled();
    });

    it("a production deployment refuses to activate an asset on a SANDBOX (testnet) network", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isNative: true, contractAddress: null, network: { code: "ethereum-sepolia", environment: "SANDBOX" } });
      await expect(productionService().setAssetNetworkActive("an-1", true)).rejects.toThrow(/may only enable PRODUCTION networks/);
      expect(prisma.assetNetwork.update).not.toHaveBeenCalled();
    });

    it("creation (active by default) is held to the same rule", async () => {
      prisma.network.findUnique.mockResolvedValue({ id: "network-9", code: "bitcoin-mainnet", environment: "PRODUCTION" });
      await expect(service.createAssetNetwork({ assetSymbol: "BTC", networkCode: "bitcoin-mainnet", isNative: true, minConfirmations: 3 })).rejects.toThrow(BadRequestException);
      expect(prisma.assetNetwork.create).not.toHaveBeenCalled();
    });

    it("deactivating a mismatched asset/network is always allowed (the way out of the unsafe state)", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isNative: true, contractAddress: null, network: { code: "ethereum-mainnet", environment: "PRODUCTION" } });
      prisma.assetNetwork.update.mockResolvedValue({ id: "an-1", isActive: false });
      await service.setAssetNetworkActive("an-1", false);
      expect(prisma.assetNetwork.update).toHaveBeenCalledWith({ where: { id: "an-1" }, data: { isActive: false } });
    });

    // Phase 41 — the complete APP_ENVIRONMENT × NetworkEnvironment matrix.
    // Only the literal "production" may enable mainnet; every other value,
    // including staging and a typo, fails closed to SANDBOX-only.
    it.each([
      ["production", "PRODUCTION", true],
      ["production", "SANDBOX", false],
      ["sandbox", "SANDBOX", true],
      ["sandbox", "PRODUCTION", false],
      ["staging", "SANDBOX", true],
      ["staging", "PRODUCTION", false],
      ["prodution", "PRODUCTION", false],
      ["", "PRODUCTION", false],
    ])("APP_ENVIRONMENT=%j creating on a %s network → allowed=%s", async (appEnvironment, networkEnvironment, allowed) => {
      const svc = new AssetsNetworksService(prisma as never, new ChainRpcConfigService(), { get: () => appEnvironment } as never);
      prisma.network.findUnique.mockResolvedValue({ id: "network-x", code: "some-network", environment: networkEnvironment });
      prisma.assetNetwork.create.mockResolvedValue({ id: "an-x" });

      const attempt = svc.createAssetNetwork({ assetSymbol: "ETH", networkCode: "some-network", isNative: true, minConfirmations: 12 });

      if (allowed) {
        await expect(attempt).resolves.toEqual({ id: "an-x" });
      } else {
        await expect(attempt).rejects.toThrow(BadRequestException);
        expect(prisma.assetNetwork.create).not.toHaveBeenCalled();
      }
    });
  });
});
