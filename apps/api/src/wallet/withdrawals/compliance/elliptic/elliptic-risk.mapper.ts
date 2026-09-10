import { AddressRiskStatus } from "../withdrawal-compliance-gate.interface";

/**
 * Elliptic's `risk_score` (VERIFIED: GET /v2/wallet/{id} response field,
 * "number, nullable float" — Phase 14B research pass) is NOT itself a
 * categorical risk level; Elliptic's schema documents no such enum.
 * Mapping a raw score onto VerdictVaut's own AddressRiskStatus is
 * therefore a VerdictVaut policy decision, made explicit and
 * admin-configurable via ComplianceProviderConfig.riskScore{Medium,High}Threshold
 * rather than a hardcoded/guessed cutoff.
 */
export function mapEllipticRiskScoreToAddressRiskStatus(riskScore: number | null | undefined, thresholds: { mediumThreshold: number | null; highThreshold: number | null }): AddressRiskStatus {
  if (riskScore == null) {
    // Elliptic reports risk_score as null until the analysis finishes
    // (process_status still "running") or if it errors — either way,
    // there is no score to categorize yet.
    return "NOT_PERFORMED";
  }
  if (thresholds.mediumThreshold == null || thresholds.highThreshold == null) {
    // Fail closed rather than guess a cutoff: an admin must explicitly
    // configure both thresholds before this provider's scores can be
    // categorized at all.
    return "ERROR";
  }
  if (riskScore >= thresholds.highThreshold) return "HIGH";
  if (riskScore >= thresholds.mediumThreshold) return "MEDIUM";
  return "LOW";
}
