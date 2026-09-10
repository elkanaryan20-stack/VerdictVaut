import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { DeferredComplianceGate } from "./withdrawals/compliance/deferred-compliance-gate";
import { WithdrawalComplianceGate } from "./withdrawals/compliance/withdrawal-compliance-gate.interface";
import { ProductionSafetyGate } from "./production-safety.gate";

function makeConfig(appEnvironment: "sandbox" | "production"): ConfigService<AppConfig, true> {
  return { get: () => appEnvironment } as unknown as ConfigService<AppConfig, true>;
}

function makePrisma(overrides: {
  kycCount?: number;
  kytCount?: number;
  custodyConfigs?: Array<{ assetNetworkId: string; custodyProviderConfig: { isEnabled: boolean; environment: string } | null }>;
} = {}) {
  return {
    complianceProviderConfig: {
      count: jest.fn().mockImplementation(async ({ where }: { where: { category: string } }) => {
        if (where.category === "KYC") return overrides.kycCount ?? 1;
        return overrides.kytCount ?? 1;
      }),
    },
    withdrawalExecutionConfig: {
      findMany: jest.fn().mockResolvedValue(overrides.custodyConfigs ?? []),
    },
  } as unknown as PrismaService;
}

const realCompliantGate: WithdrawalComplianceGate = { assess: async () => ({ decision: "PASS" }) } as never;

describe("ProductionSafetyGate", () => {
  it("does nothing outside production, even with the deferred compliance gate bound", async () => {
    const gate = new ProductionSafetyGate(makeConfig("sandbox"), makePrisma(), new DeferredComplianceGate());
    await expect(gate.onApplicationBootstrap()).resolves.not.toThrow();
  });

  it("refuses to finish starting in production while DeferredComplianceGate is still bound", async () => {
    const gate = new ProductionSafetyGate(makeConfig("production"), makePrisma(), new DeferredComplianceGate());
    await expect(gate.onApplicationBootstrap()).rejects.toThrow(/DeferredComplianceGate/);
  });

  describe("once a real compliance gate implementation replaces the deferred one", () => {
    it("still refuses production without an enabled KYC ComplianceProviderConfig", async () => {
      const gate = new ProductionSafetyGate(makeConfig("production"), makePrisma({ kycCount: 0 }), realCompliantGate);
      await expect(gate.onApplicationBootstrap()).rejects.toThrow(/KYC ComplianceProviderConfig/);
    });

    it("still refuses production without an enabled SANCTIONS_KYT ComplianceProviderConfig", async () => {
      const gate = new ProductionSafetyGate(makeConfig("production"), makePrisma({ kytCount: 0 }), realCompliantGate);
      await expect(gate.onApplicationBootstrap()).rejects.toThrow(/SANCTIONS_KYT ComplianceProviderConfig/);
    });

    it("refuses production when a PRODUCTION_CUSTODY WithdrawalExecutionConfig has no linked custody provider config", async () => {
      const prisma = makePrisma({ custodyConfigs: [{ assetNetworkId: "an-1", custodyProviderConfig: null }] });
      const gate = new ProductionSafetyGate(makeConfig("production"), prisma, realCompliantGate);
      await expect(gate.onApplicationBootstrap()).rejects.toThrow(/an-1/);
    });

    it("refuses production when the linked custody provider config is disabled", async () => {
      const prisma = makePrisma({
        custodyConfigs: [{ assetNetworkId: "an-1", custodyProviderConfig: { isEnabled: false, environment: "PRODUCTION" } }],
      });
      const gate = new ProductionSafetyGate(makeConfig("production"), prisma, realCompliantGate);
      await expect(gate.onApplicationBootstrap()).rejects.toThrow(/disabled/);
    });

    it("refuses production when the linked custody provider config is SANDBOX, not PRODUCTION", async () => {
      const prisma = makePrisma({
        custodyConfigs: [{ assetNetworkId: "an-1", custodyProviderConfig: { isEnabled: true, environment: "SANDBOX" } }],
      });
      const gate = new ProductionSafetyGate(makeConfig("production"), prisma, realCompliantGate);
      await expect(gate.onApplicationBootstrap()).rejects.toThrow(/an-1/);
    });

    it("allows production bootstrap once compliance AND custody configuration are both genuinely complete", async () => {
      const prisma = makePrisma({
        custodyConfigs: [{ assetNetworkId: "an-1", custodyProviderConfig: { isEnabled: true, environment: "PRODUCTION" } }],
      });
      const gate = new ProductionSafetyGate(makeConfig("production"), prisma, realCompliantGate);
      await expect(gate.onApplicationBootstrap()).resolves.not.toThrow();
    });
  });
});
