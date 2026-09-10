import { NetworkFamily, Prisma, WithdrawalComplianceDecision } from "@prisma/client";
import { PrismaService } from "../../../../prisma/prisma.service";
import { SecretResolverService } from "../../../provider-config/secret-resolver.service";
import { EllipticAddressRiskGate } from "./elliptic-address-risk.gate";

function context(overrides: Partial<{ networkFamily: NetworkFamily; destinationAddress: string }> = {}) {
  return {
    userId: "user-1",
    assetSymbol: "USDC",
    networkCode: "ethereum-sepolia",
    networkFamily: overrides.networkFamily ?? NetworkFamily.EVM,
    amount: new Prisma.Decimal("100"),
    destinationAddress: overrides.destinationAddress ?? "0x000000000000000000000000000000000000dEaD",
  };
}

describe("EllipticAddressRiskGate", () => {
  let prisma: { complianceProviderConfig: { findFirst: jest.Mock } };
  let secretResolver: { resolve: jest.Mock };
  let gate: EllipticAddressRiskGate;
  let fetchMock: jest.Mock;

  const enabledConfig = {
    apiBaseUrl: "https://aml-api.elliptic.co/v2",
    credentialsSecretRef: "env:ELLIPTIC_CREDENTIALS",
    timeoutMs: 10000,
    riskScoreMediumThreshold: 0.3,
    riskScoreHighThreshold: 0.7,
  };

  beforeEach(() => {
    prisma = { complianceProviderConfig: { findFirst: jest.fn().mockResolvedValue(enabledConfig) } };
    secretResolver = { resolve: jest.fn().mockReturnValue(JSON.stringify({ apiKey: "key", apiSecret: Buffer.from("secret").toString("base64") })) };
    gate = new EllipticAddressRiskGate(prisma as unknown as PrismaService, secretResolver as unknown as SecretResolverService);
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });

  it("reports NOT_PERFORMED signals (never guesses) for a non-EVM network family — no HTTP call made", async () => {
    const result = await gate.assess(context({ networkFamily: NetworkFamily.BITCOIN }));
    expect(result.decision).toBe(WithdrawalComplianceDecision.DEFERRED);
    expect(result.signals?.addressRiskScreeningStatus).toBe("NOT_PERFORMED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defers when no enabled Elliptic ComplianceProviderConfig exists", async () => {
    prisma.complianceProviderConfig.findFirst.mockResolvedValue(null);
    const result = await gate.assess(context());
    expect(result.decision).toBe(WithdrawalComplianceDecision.DEFERRED);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits a wallet_exposure analysis for the destination address and BLOCKS on a HIGH risk score", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify([{ id: "an-1", process_status: "running" }]) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ id: "an-1", risk_score: 0.9, process_status: "complete" }) });

    const result = await gate.assess(context());

    expect(result.decision).toBe(WithdrawalComplianceDecision.BLOCKED);
    expect(result.signals?.addressRiskScreeningStatus).toBe("HIGH");
    expect(result.signals?.providerReference).toBe("an-1");

    const submitBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(submitBody).toEqual([{ subject: { asset: "holistic", blockchain: "holistic", type: "address", hash: context().destinationAddress }, type: "wallet_exposure" }]);
  });

  it("defers (never auto-passes) on a LOW risk score, still recording the signal", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify([{ id: "an-2", process_status: "running" }]) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ id: "an-2", risk_score: 0.05, process_status: "complete" }) });

    const result = await gate.assess(context());

    expect(result.decision).toBe(WithdrawalComplianceDecision.DEFERRED);
    expect(result.signals?.addressRiskScreeningStatus).toBe("LOW");
  });

  it("reports NOT_PERFORMED (never a guessed score) when the analysis has not completed by the single follow-up read", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify([{ id: "an-3", process_status: "running" }]) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ id: "an-3", risk_score: null, process_status: "running" }) });

    const result = await gate.assess(context());

    expect(result.decision).toBe(WithdrawalComplianceDecision.DEFERRED);
    expect(result.signals?.addressRiskScreeningStatus).toBe("NOT_PERFORMED");
  });

  it("never crashes, and never silently passes, when the Elliptic call itself fails", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const result = await gate.assess(context());
    expect(result.decision).toBe(WithdrawalComplianceDecision.DEFERRED);
    expect(result.signals?.addressRiskScreeningStatus).toBe("ERROR");
  });

  it("reports ERROR (not a guessed tier) when risk thresholds are not configured on the provider row", async () => {
    prisma.complianceProviderConfig.findFirst.mockResolvedValue({ ...enabledConfig, riskScoreMediumThreshold: null, riskScoreHighThreshold: null });
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify([{ id: "an-4", process_status: "running" }]) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ id: "an-4", risk_score: 0.9, process_status: "complete" }) });

    const result = await gate.assess(context());
    expect(result.signals?.addressRiskScreeningStatus).toBe("ERROR");
  });
});
