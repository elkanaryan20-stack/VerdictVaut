import { InternalServerErrorException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { FireblocksCustodyAdapter } from "./fireblocks/fireblocks-custody.adapter";
import { ManualBroadcastExecutor } from "./manual-broadcast.executor";
import { ProductionCustodyExecutor } from "./production-custody.executor";
import { WithdrawalExecutorFactory } from "./withdrawal-executor.factory";

describe("WithdrawalExecutorFactory", () => {
  let prisma: { withdrawalExecutionConfig: { findUnique: jest.Mock } };
  let config: { get: jest.Mock };
  let manual: ManualBroadcastExecutor;
  let production: ProductionCustodyExecutor;
  let fireblocks: FireblocksCustodyAdapter;
  let factory: WithdrawalExecutorFactory;

  beforeEach(() => {
    prisma = { withdrawalExecutionConfig: { findUnique: jest.fn() } };
    config = { get: jest.fn().mockReturnValue("sandbox") };
    manual = new ManualBroadcastExecutor();
    production = new ProductionCustodyExecutor();
    fireblocks = { execute: jest.fn(), checkStatus: jest.fn(), supportsAssetNetwork: jest.fn().mockResolvedValue(true) } as unknown as FireblocksCustodyAdapter;
    factory = new WithdrawalExecutorFactory(prisma as unknown as PrismaService, config as never, manual, production, fireblocks);
  });

  it("defaults to ManualBroadcastExecutor in sandbox when no config row exists", async () => {
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue(null);
    expect(await factory.resolve("an-1")).toBe(manual);
  });

  it("refuses to fall back to manual broadcast in production when no PRODUCTION_CUSTODY config exists", async () => {
    config.get.mockReturnValue("production");
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue(null);

    await expect(factory.resolve("an-1")).rejects.toThrow(InternalServerErrorException);
  });

  it("refuses to fall back to manual broadcast in production even if a MANUAL_BROADCAST config row exists", async () => {
    config.get.mockReturnValue("production");
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({ executorType: "MANUAL_BROADCAST" });

    await expect(factory.resolve("an-1")).rejects.toThrow(InternalServerErrorException);
  });

  it("uses ProductionCustodyExecutor (the still-throwing placeholder) in production when explicitly configured with an enabled, linked, environment-matching custody provider config — Phase 14B never enables real production execution", async () => {
    config.get.mockReturnValue("production");
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
      executorType: "PRODUCTION_CUSTODY",
      custodyProviderConfig: { id: "cfg-1", isEnabled: true, providerName: "Fireblocks", environment: "PRODUCTION" },
    });

    expect(await factory.resolve("an-1")).toBe(production);
  });

  it("refuses in production when the linked custody provider config exists but is disabled", async () => {
    config.get.mockReturnValue("production");
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
      executorType: "PRODUCTION_CUSTODY",
      custodyProviderConfig: { id: "cfg-1", isEnabled: false, environment: "PRODUCTION" },
    });

    await expect(factory.resolve("an-1")).rejects.toThrow(InternalServerErrorException);
  });

  describe("A1 — provider config environment isolation (security review finding)", () => {
    it("REJECTS: APP_ENVIRONMENT=sandbox + a PRODUCTION-flagged custody config", async () => {
      config.get.mockReturnValue("sandbox");
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfig: { id: "cfg-1", isEnabled: true, providerName: "Fireblocks", environment: "PRODUCTION" },
      });
      await expect(factory.resolve("an-1")).rejects.toThrow(/flagged PRODUCTION/);
    });

    it("REJECTS: APP_ENVIRONMENT=staging (any non-production value) + a PRODUCTION-flagged custody config", async () => {
      config.get.mockReturnValue("staging");
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfig: { id: "cfg-1", isEnabled: true, providerName: "Fireblocks", environment: "PRODUCTION" },
      });
      await expect(factory.resolve("an-1")).rejects.toThrow(/flagged PRODUCTION/);
    });

    it("REJECTS: APP_ENVIRONMENT=production + a SANDBOX-flagged custody config", async () => {
      config.get.mockReturnValue("production");
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfig: { id: "cfg-1", isEnabled: true, providerName: "Fireblocks", environment: "SANDBOX" },
      });
      await expect(factory.resolve("an-1")).rejects.toThrow(/flagged SANDBOX/);
    });

    it("ALLOWS: matching environment (sandbox process + SANDBOX config) resolves normally", async () => {
      config.get.mockReturnValue("sandbox");
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfig: { id: "cfg-1", isEnabled: true, providerName: "Fireblocks", environment: "SANDBOX" },
      });
      expect(await factory.resolve("an-1")).toBe(fireblocks);
    });

    it("ALLOWS: matching environment (production process + PRODUCTION config) resolves to the safe placeholder", async () => {
      config.get.mockReturnValue("production");
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfig: { id: "cfg-1", isEnabled: true, providerName: "Fireblocks", environment: "PRODUCTION" },
      });
      expect(await factory.resolve("an-1")).toBe(production);
    });
  });

  it("refuses in production when PRODUCTION_CUSTODY is selected but no custody provider config is linked at all", async () => {
    config.get.mockReturnValue("production");
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({ executorType: "PRODUCTION_CUSTODY", custodyProviderConfig: null });

    await expect(factory.resolve("an-1")).rejects.toThrow(InternalServerErrorException);
  });

  describe("sandbox + PRODUCTION_CUSTODY (Phase 14B — real provider adapter routing)", () => {
    it("routes to FireblocksCustodyAdapter when the linked, enabled provider config's providerName is Fireblocks", async () => {
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfig: { id: "cfg-1", isEnabled: true, providerName: "Fireblocks", environment: "SANDBOX" },
      });
      expect(await factory.resolve("an-1")).toBe(fireblocks);
    });

    it("matches providerName case-insensitively", async () => {
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfig: { id: "cfg-1", isEnabled: true, providerName: "fireblocks", environment: "SANDBOX" },
      });
      expect(await factory.resolve("an-1")).toBe(fireblocks);
    });

    it("fails closed (never falls back to manual broadcast or the placeholder) when no custody provider config is linked", async () => {
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({ executorType: "PRODUCTION_CUSTODY", custodyProviderConfig: null });
      await expect(factory.resolve("an-1")).rejects.toThrow(InternalServerErrorException);
    });

    it("fails closed when the linked provider config is disabled", async () => {
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfig: { id: "cfg-1", isEnabled: false, providerName: "Fireblocks", environment: "SANDBOX" },
      });
      await expect(factory.resolve("an-1")).rejects.toThrow(InternalServerErrorException);
    });

    it("fails closed (never silently falls back) for an unrecognized providerName", async () => {
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfig: { id: "cfg-1", isEnabled: true, providerName: "BitGo", environment: "SANDBOX" },
      });
      await expect(factory.resolve("an-1")).rejects.toThrow(/no corresponding adapter/);
    });
  });

  describe("supportsAssetNetwork", () => {
    it("rejects when the resolved executor declares it does not support this asset/network", async () => {
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue(null);
      const pickyManual = { execute: jest.fn(), supportsAssetNetwork: jest.fn().mockResolvedValue(false) };
      const pickyFactory = new WithdrawalExecutorFactory(prisma as unknown as PrismaService, config as never, pickyManual as never, production, fireblocks);

      await expect(pickyFactory.resolve("an-1")).rejects.toThrow(InternalServerErrorException);
    });

    it("allows resolution when the executor declares support, or declares no opinion at all (optional method)", async () => {
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue(null);
      const supportiveManual = { execute: jest.fn(), supportsAssetNetwork: jest.fn().mockResolvedValue(true) };
      const supportiveFactory = new WithdrawalExecutorFactory(prisma as unknown as PrismaService, config as never, supportiveManual as never, production, fireblocks);

      expect(await supportiveFactory.resolve("an-1")).toBe(supportiveManual);
      // manual (no supportsAssetNetwork at all) from the top-level `factory` still works, per the very first test.
    });
  });
});
