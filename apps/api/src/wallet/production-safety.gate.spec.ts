import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { DeferredComplianceGate } from "./withdrawals/compliance/deferred-compliance-gate";
import { WithdrawalComplianceGate } from "./withdrawals/compliance/withdrawal-compliance-gate.interface";
import { ProductionSafetyGate } from "./production-safety.gate";

function makeConfig(appEnvironment: "sandbox" | "production"): ConfigService<AppConfig, true> {
  return { get: () => appEnvironment } as unknown as ConfigService<AppConfig, true>;
}

describe("ProductionSafetyGate", () => {
  it("does nothing outside production, even with the deferred compliance gate bound", () => {
    const gate = new ProductionSafetyGate(makeConfig("sandbox"), new DeferredComplianceGate());
    expect(() => gate.onApplicationBootstrap()).not.toThrow();
  });

  it("refuses to finish starting in production while DeferredComplianceGate is still bound", () => {
    const gate = new ProductionSafetyGate(makeConfig("production"), new DeferredComplianceGate());
    expect(() => gate.onApplicationBootstrap()).toThrow(/DeferredComplianceGate/);
  });

  it("allows production bootstrap once a real compliance gate implementation replaces the deferred one", () => {
    const realGate: WithdrawalComplianceGate = { assess: async () => ({ decision: "PASS" }) } as never;
    const gate = new ProductionSafetyGate(makeConfig("production"), realGate);
    expect(() => gate.onApplicationBootstrap()).not.toThrow();
  });
});
