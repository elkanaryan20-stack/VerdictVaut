import { Prisma, WithdrawalComplianceDecision } from "@prisma/client";

export interface WithdrawalComplianceContext {
  userId: string;
  assetSymbol: string;
  networkCode: string;
  amount: Prisma.Decimal;
  destinationAddress: string;
}

/**
 * A single category's outcome — PASS/FAIL/REVIEW are what a real
 * provider would report; NOT_PERFORMED is what DeferredComplianceGate
 * honestly reports for every category today, since no real check ever
 * ran. Never silently absent: an implementation states NOT_PERFORMED
 * explicitly rather than leaving a category undefined, so "we didn't
 * check this" is always visible in the audit trail, not indistinguishable
 * from "we forgot to report it."
 */
export type ComplianceCheckStatus = "PASS" | "FAIL" | "REVIEW" | "NOT_PERFORMED";

export interface WithdrawalComplianceSignals {
  /** Identity/onboarding verification status for this user — a KYC provider's job, not a per-withdrawal check. */
  kycStatus?: ComplianceCheckStatus;
  /** Sanctions/PEP list screening of the user's own identity. */
  sanctionsScreeningStatus?: ComplianceCheckStatus;
  /** Risk screening of THIS withdrawal's specific destination address (e.g. a crypto-AML provider's address/transaction risk score). */
  addressRiskScreeningStatus?: ComplianceCheckStatus;
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
