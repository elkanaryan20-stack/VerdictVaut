import { ConfigService } from "@nestjs/config";
import { NetworkFamily, Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
import { AppConfig } from "../../../config/configuration";
import { ComplianceGateFactory } from "./compliance-gate.factory";
import { DeferredComplianceGate } from "./deferred-compliance-gate";
import { EllipticAddressRiskGate } from "./elliptic/elliptic-address-risk.gate";

function context() {
  return {
    userId: "user-1",
    assetSymbol: "USDC",
    networkCode: "ethereum-sepolia",
    networkFamily: NetworkFamily.EVM,
    amount: new Prisma.Decimal("100"),
    destinationAddress: "0x000000000000000000000000000000000000dEaD",
  };
}

describe("ComplianceGateFactory", () => {
  let prisma: { complianceProviderConfig: { findFirst: jest.Mock } };
  let config: { get: jest.Mock };
  let deferredGate: { assess: jest.Mock };
  let ellipticGate: { assess: jest.Mock };
  let factory: ComplianceGateFactory;

  beforeEach(() => {
    prisma = { complianceProviderConfig: { findFirst: jest.fn().mockResolvedValue(null) } };
    config = { get: jest.fn().mockReturnValue("development") };
    deferredGate = { assess: jest.fn().mockResolvedValue({ decision: "DEFERRED" }) };
    ellipticGate = { assess: jest.fn().mockResolvedValue({ decision: "DEFERRED" }) };
    factory = new ComplianceGateFactory(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService<AppConfig, true>,
      deferredGate as unknown as DeferredComplianceGate,
      ellipticGate as unknown as EllipticAddressRiskGate,
    );
  });

  it("in production, ALWAYS uses DeferredComplianceGate, regardless of any Elliptic config", async () => {
    config.get.mockReturnValue("production");
    prisma.complianceProviderConfig.findFirst.mockResolvedValue({ id: "cfg-1" });

    await factory.assess(context());

    expect(deferredGate.assess).toHaveBeenCalled();
    expect(ellipticGate.assess).not.toHaveBeenCalled();
    expect(prisma.complianceProviderConfig.findFirst).not.toHaveBeenCalled();
  });

  it("in sandbox with no enabled Elliptic config, falls back to DeferredComplianceGate", async () => {
    await factory.assess(context());
    expect(deferredGate.assess).toHaveBeenCalled();
    expect(ellipticGate.assess).not.toHaveBeenCalled();
  });

  it("in sandbox with an enabled Elliptic config, routes to EllipticAddressRiskGate", async () => {
    prisma.complianceProviderConfig.findFirst.mockResolvedValue({ id: "cfg-1" });
    await factory.assess(context());
    expect(ellipticGate.assess).toHaveBeenCalled();
    expect(deferredGate.assess).not.toHaveBeenCalled();
  });
});
