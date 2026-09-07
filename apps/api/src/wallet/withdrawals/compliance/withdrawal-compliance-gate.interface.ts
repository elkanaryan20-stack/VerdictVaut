import { Prisma, WithdrawalComplianceDecision } from "@prisma/client";

export interface WithdrawalComplianceContext {
  userId: string;
  assetSymbol: string;
  networkCode: string;
  amount: Prisma.Decimal;
  destinationAddress: string;
}

export interface WithdrawalComplianceAssessment {
  decision: WithdrawalComplianceDecision;
  /** Human-readable reason — required for BLOCKED, optional otherwise. Never a secret; safe to audit-log and to show a SUPER_ADMIN reviewer. */
  reason?: string;
}

/**
 * The explicit integration boundary for KYC status, sanctions/AML
 * screening, restricted-jurisdiction checks, and withdrawal risk
 * scoring — none of which this platform has a real implementation of
 * yet (see DeferredComplianceGate). WithdrawalsService.request() always
 * calls this and always records its result (WithdrawalComplianceDecision
 * + complianceNote) on the withdrawal row — a withdrawal is NEVER
 * silently treated as compliance-approved just because no real check
 * exists. A BLOCKED decision stops the request outright, with the
 * gate's own reason surfaced to the caller; PASS and DEFERRED both let
 * the request proceed to the mandatory human SUPER_ADMIN review step,
 * which remains the one real gate today.
 */
export interface WithdrawalComplianceGate {
  assess(context: WithdrawalComplianceContext): Promise<WithdrawalComplianceAssessment>;
}

export const WITHDRAWAL_COMPLIANCE_GATE = Symbol("WithdrawalComplianceGate");
