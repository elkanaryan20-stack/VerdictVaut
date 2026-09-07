import { Prisma } from "@prisma/client";
import { DeferredComplianceGate } from "./deferred-compliance-gate";

describe("DeferredComplianceGate", () => {
  it("always reports DEFERRED (never PASS or BLOCKED) — honest about having no real screening system", async () => {
    const gate = new DeferredComplianceGate();
    const result = await gate.assess({
      userId: "user-1",
      assetSymbol: "USDC",
      networkCode: "ethereum-sepolia",
      amount: new Prisma.Decimal("100"),
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    expect(result.decision).toBe("DEFERRED");
    expect(result.reason).toBeTruthy();
  });
});
