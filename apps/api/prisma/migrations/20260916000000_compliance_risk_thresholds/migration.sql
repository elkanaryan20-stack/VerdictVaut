-- Phase 14B: admin-configured thresholds for mapping a raw provider risk
-- score (e.g. Elliptic's numeric risk_score) onto VerdictVaut's own
-- categorical AddressRiskStatus. Nullable — providers that never report a
-- numeric score (e.g. a pure KYC provider) simply leave these unset.
ALTER TABLE "compliance_provider_configs"
  ADD COLUMN "riskScoreMediumThreshold" DOUBLE PRECISION,
  ADD COLUMN "riskScoreHighThreshold" DOUBLE PRECISION;
