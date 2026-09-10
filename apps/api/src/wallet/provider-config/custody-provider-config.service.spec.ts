import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CustodyProviderConfigService } from "./custody-provider-config.service";

describe("CustodyProviderConfigService", () => {
  let prisma: {
    custodyProviderConfig: { create: jest.Mock; update: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
    assetNetwork: { findUnique: jest.Mock };
    withdrawalExecutionConfig: { upsert: jest.Mock; findMany: jest.Mock };
  };
  let service: CustodyProviderConfigService;

  beforeEach(() => {
    prisma = {
      custodyProviderConfig: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
      assetNetwork: { findUnique: jest.fn() },
      withdrawalExecutionConfig: { upsert: jest.fn(), findMany: jest.fn() },
    };
    service = new CustodyProviderConfigService(prisma as unknown as PrismaService);
  });

  describe("createCustodyProviderConfig", () => {
    it("rejects a raw-looking credentialsSecretRef instead of storing it", async () => {
      await expect(
        service.createCustodyProviderConfig({ providerName: "Fireblocks", environment: "PRODUCTION", credentialsSecretRef: "sk_live_abc123" }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.custodyProviderConfig.create).not.toHaveBeenCalled();
    });

    it("rejects a non-positive timeoutMs", async () => {
      await expect(
        service.createCustodyProviderConfig({ providerName: "Fireblocks", environment: "PRODUCTION", timeoutMs: 0 }),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates a config always starting disabled, even if the caller didn't say so", async () => {
      prisma.custodyProviderConfig.create.mockResolvedValue({ id: "cfg-1" });
      await service.createCustodyProviderConfig({ providerName: "Fireblocks", environment: "PRODUCTION", credentialsSecretRef: "env:FIREBLOCKS_KEY" });
      expect(prisma.custodyProviderConfig.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isEnabled: false, providerName: "Fireblocks" }) }),
      );
    });
  });

  describe("setCustodyProviderEnabled", () => {
    it("throws NotFoundException for an unknown id", async () => {
      prisma.custodyProviderConfig.findUnique.mockResolvedValue(null);
      await expect(service.setCustodyProviderEnabled("missing", true)).rejects.toThrow(NotFoundException);
    });

    it("enables/disables an existing config", async () => {
      prisma.custodyProviderConfig.findUnique.mockResolvedValue({ id: "cfg-1" });
      prisma.custodyProviderConfig.update.mockResolvedValue({ id: "cfg-1", isEnabled: true });
      await service.setCustodyProviderEnabled("cfg-1", true);
      expect(prisma.custodyProviderConfig.update).toHaveBeenCalledWith({ where: { id: "cfg-1" }, data: { isEnabled: true } });
    });
  });

  describe("setWithdrawalExecutionConfig", () => {
    it("throws NotFoundException for an unknown asset/network", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue(null);
      await expect(
        service.setWithdrawalExecutionConfig({ assetNetworkId: "an-1", environment: "PRODUCTION", executorType: "MANUAL_BROADCAST" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects configuring withdrawal execution for an inactive asset/network", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isActive: false });
      await expect(
        service.setWithdrawalExecutionConfig({ assetNetworkId: "an-1", environment: "PRODUCTION", executorType: "MANUAL_BROADCAST" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("PRODUCTION_CUSTODY without a custodyProviderConfigId is rejected", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isActive: true });
      await expect(
        service.setWithdrawalExecutionConfig({ assetNetworkId: "an-1", environment: "PRODUCTION", executorType: "PRODUCTION_CUSTODY" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("PRODUCTION_CUSTODY with an unknown custodyProviderConfigId is rejected", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isActive: true });
      prisma.custodyProviderConfig.findUnique.mockResolvedValue(null);
      await expect(
        service.setWithdrawalExecutionConfig({
          assetNetworkId: "an-1",
          environment: "PRODUCTION",
          executorType: "PRODUCTION_CUSTODY",
          custodyProviderConfigId: "cfg-missing",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects an environment mismatch between the execution config and the linked provider config", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isActive: true });
      prisma.custodyProviderConfig.findUnique.mockResolvedValue({ id: "cfg-1", environment: "SANDBOX" });
      await expect(
        service.setWithdrawalExecutionConfig({
          assetNetworkId: "an-1",
          environment: "PRODUCTION",
          executorType: "PRODUCTION_CUSTODY",
          custodyProviderConfigId: "cfg-1",
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.withdrawalExecutionConfig.upsert).not.toHaveBeenCalled();
    });

    it("accepts a consistent PRODUCTION_CUSTODY configuration", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isActive: true });
      prisma.custodyProviderConfig.findUnique.mockResolvedValue({ id: "cfg-1", environment: "PRODUCTION" });
      prisma.withdrawalExecutionConfig.upsert.mockResolvedValue({ id: "wec-1" });

      await service.setWithdrawalExecutionConfig({
        assetNetworkId: "an-1",
        environment: "PRODUCTION",
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfigId: "cfg-1",
      });

      expect(prisma.withdrawalExecutionConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ custodyProviderConfigId: "cfg-1", executorType: "PRODUCTION_CUSTODY" }),
        }),
      );
    });

    it("clears custodyProviderConfigId when switching back to MANUAL_BROADCAST, even if one was passed", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ id: "an-1", isActive: true });
      prisma.withdrawalExecutionConfig.upsert.mockResolvedValue({ id: "wec-1" });

      await service.setWithdrawalExecutionConfig({
        assetNetworkId: "an-1",
        environment: "SANDBOX",
        executorType: "MANUAL_BROADCAST",
        custodyProviderConfigId: "stale-cfg-id",
      });

      expect(prisma.withdrawalExecutionConfig.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ custodyProviderConfigId: null }),
          update: expect.objectContaining({ custodyProviderConfigId: null }),
        }),
      );
    });
  });
});
