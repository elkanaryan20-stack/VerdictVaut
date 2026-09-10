import { NetworkFamily, Prisma, WithdrawalComplianceDecision } from "@prisma/client";

export interface WithdrawalComplianceContext {
  userId: string;
  assetSymbol: string;
  networkCode: string;
  /** Needed by a real address-risk adapter to know whether its verified request shape even applies to this network — see EllipticAddressRiskGate's docblock. */
  networkFamily: NetworkFamily;
  amount: Prisma.Decimal;
  destinationAddress: string;
}

/**
 * Identity/onboarding verification status for this user — a KYC
 * provider's job, not a per-withdrawal check. NOT_PERFORMED is what
 * DeferredComplianceGate honestly reports today, since no real check
 * ever ran; REVIEW is a provider's own "needs manual look" outcome,
 * distinct from this platform's own separate mandatory SUPER_ADMIN
 * review step.
 */
export type KycStatus = "NOT_PERFORMED" | "PENDING" | "PASSED" | "FAILED" | "REVIEW";

/**
 * Sanctions/PEP list screening of the user's own identity. Distinct
 * from KycStatus (identity verification) and AddressRiskStatus
 * (destination-address risk) — a real provider (e.g. Chainalysis,
 * Elliptic) reports these as separate concerns, and conflating them
 * would hide which specific check produced a BLOCKED decision.
 */
export type SanctionsStatus = "NOT_PERFORMED" | "CLEAR" | "HIT" | "REVIEW" | "ERROR";

/**
 * Risk screening of THIS withdrawal's specific destination address
 * (e.g. a crypto-AML provider's address/transaction risk score).
 * LOW/MEDIUM/HIGH mirror a categorical risk-tier report; a provider
 * that instead returns a raw numeric score (e.g. Elliptic's
 * risk_score) must map it to one of these tiers via an explicit,
 * admin-configured threshold — VerdictVaut policy, not something the
 * provider itself defines.
 */
export type AddressRiskStatus = "NOT_PERFORMED" | "LOW" | "MEDIUM" | "HIGH" | "BLOCKED" | "ERROR";

export interface WithdrawalComplianceSignals {
  kycStatus?: KycStatus;
  sanctionsScreeningStatus?: SanctionsStatus;
  addressRiskScreeningStatus?: AddressRiskStatus;
  /** The provider's own reference/case id for this assessment, if any — never a secret, safe to audit-log and show a SUPER_ADMIN reviewer. */
  providerReference?: string;
}

export interface WithdrawalComplianceAssessment {
  decision: WithdrawalComplianceDecision;
  /** Human-readable reason — required for BLOCKED, optional otherwise. Never a secret; safe to audit-log and to show a SUPER_ADMIN reviewer. */
  reason?: string;
  /**
   * Optional, structured per-category findings underlying `decision` —
   * see WithdrawalComplianceSignals. A real implementation should
   * populate this so a BLOCKED/DEFERRED decision's specific cause is
   * visible, not just the top-level decision; DeferredComplianceGate
   * populates every category as NOT_PERFORMED rather than omitting it.
   */
  signals?: WithdrawalComplianceSignals;
}

/**
 * The explicit integration boundary for KYC status, sanctions/AML
 * screening, restricted-jurisdiction checks, and withdrawal risk
 * scoring — none of which this platform has a real implementation of
 * yet (see DeferredComplianceGate). WithdrawalsService.request() always
 * calls this and always records its result (WithdrawalComplianceDecision
 * + complianceNote, plus `signals` in the audit trail) on/around the
 * withdrawal row — a withdrawal is NEVER silently treated as
 * compliance-approved just because no real check exists. A BLOCKED
 * decision stops the request outright, with the gate's own reason
 * surfaced to the caller; PASS and DEFERRED both let the request
 * proceed to the mandatory human SUPER_ADMIN review step, which remains
 * the one real gate today regardless of what a real implementation's
 * `signals` report — this interface adds detail for that human reviewer
 * to see, it does not replace their review.
 */
export interface WithdrawalComplianceGate {
  assess(context: WithdrawalComplianceContext): Promise<WithdrawalComplianceAssessment>;
}

export const WITHDRAWAL_COMPLIANCE_GATE = Symbol("WithdrawalComplianceGate");
