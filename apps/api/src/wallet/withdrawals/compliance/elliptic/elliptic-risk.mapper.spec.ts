import { mapEllipticRiskScoreToAddressRiskStatus } from "./elliptic-risk.mapper";

describe("mapEllipticRiskScoreToAddressRiskStatus", () => {
  const thresholds = { mediumThreshold: 0.3, highThreshold: 0.7 };

  it("returns NOT_PERFORMED for a null score (analysis still running or errored with no result)", () => {
    expect(mapEllipticRiskScoreToAddressRiskStatus(null, thresholds)).toBe("NOT_PERFORMED");
    expect(mapEllipticRiskScoreToAddressRiskStatus(undefined, thresholds)).toBe("NOT_PERFORMED");
  });

  it("returns ERROR (never a guessed tier) when thresholds are not configured", () => {
    expect(mapEllipticRiskScoreToAddressRiskStatus(0.9, { mediumThreshold: null, highThreshold: null })).toBe("ERROR");
    expect(mapEllipticRiskScoreToAddressRiskStatus(0.9, { mediumThreshold: 0.3, highThreshold: null })).toBe("ERROR");
  });

  it("returns LOW below the medium threshold", () => {
    expect(mapEllipticRiskScoreToAddressRiskStatus(0.1, thresholds)).toBe("LOW");
  });

  it("returns MEDIUM at/above the medium threshold and below the high threshold", () => {
    expect(mapEllipticRiskScoreToAddressRiskStatus(0.3, thresholds)).toBe("MEDIUM");
    expect(mapEllipticRiskScoreToAddressRiskStatus(0.69, thresholds)).toBe("MEDIUM");
  });

  it("returns HIGH at/above the high threshold", () => {
    expect(mapEllipticRiskScoreToAddressRiskStatus(0.7, thresholds)).toBe("HIGH");
    expect(mapEllipticRiskScoreToAddressRiskStatus(1.0, thresholds)).toBe("HIGH");
  });
});
