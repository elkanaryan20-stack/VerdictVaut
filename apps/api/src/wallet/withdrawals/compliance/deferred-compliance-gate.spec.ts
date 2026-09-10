import { NetworkFamily, Prisma } from "@prisma/client";
import { DeferredComplianceGate } from "./deferred-compliance-gate";

describe("DeferredComplianceGate", () => {
  it("always reports DEFERRED (never PASS or BLOCKED) — honest about having no real screening system", async () => {
    const gate = new DeferredComplianceGate();
    const result = await gate.assess({
      userId: "user-1",
      assetSymbol: "USDC",
      networkCode: "ethereum-sepolia",
      networkFamily: NetworkFamily.EVM,
      amount: new Prisma.Decimal("100"),
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    expect(result.decision).toBe("DEFERRED");
    expect(result.reason).toBeTruthy();
  });

  it("explicitly reports NOT_PERFORMED for every signal category, rather than omitting them", async () => {
    const gate = new DeferredComplianceGate();
    const result = await gate.assess({
      userId: "user-1",
      assetSymbol: "USDC",
      networkCode: "ethereum-sepolia",
      networkFamily: NetworkFamily.EVM,
      amount: new Prisma.Decimal("100"),
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    expect(result.signals).toEqual({
      kycStatus: "NOT_PERFORMED",
      sanctionsScreeningStatus: "NOT_PERFORMED",
      addressRiskScreeningStatus: "NOT_PERFORMED",
    });
  });
});
