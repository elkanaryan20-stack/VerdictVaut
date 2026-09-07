import { Injectable } from "@nestjs/common";
import { WithdrawalComplianceDecision } from "@prisma/client";
import {
  WithdrawalComplianceAssessment,
  WithdrawalComplianceContext,
  WithdrawalComplianceGate,
} from "./withdrawal-compliance-gate.interface";

/**
 * Default implementation: this platform has no real KYC/AML/sanctions/
 * jurisdiction-screening system wired up yet. Rather than fabricate a
 * pass (which would misrepresent an unchecked withdrawal as
 * compliance-approved) or block every withdrawal outright (which would
 * make the feature nonfunctional with no real system to eventually
 * clear the block), this honestly reports DEFERRED — recorded on the
 * withdrawal and visible to the SUPER_ADMIN reviewer, who remains the
 * one real gate today. A real implementation (KYC provider lookup,
 * sanctions list screening, jurisdiction/velocity checks) is explicit
 * production work that must replace this before real-money withdrawals
 * — see the Phase 9 report's compliance-readiness section.
 */
@Injectable()
export class DeferredComplianceGate implements WithdrawalComplianceGate {
  async assess(_context: WithdrawalComplianceContext): Promise<WithdrawalComplianceAssessment> {
    return {
      decision: WithdrawalComplianceDecision.DEFERRED,
      reason: "No KYC/AML/sanctions-screening system is integrated yet — pending mandatory human SUPER_ADMIN review.",
    };
  }
}
