import { Withdrawal, WithdrawalStatus } from "@prisma/client";

/**
 * Phase 36 — the shape a withdrawal's OWNER receives from
 * /wallet/withdrawals. Operator/compliance internals are nulled (not
 * removed, so the shared WithdrawalSchema contract is unchanged):
 *   - complianceNote: a sandbox address-risk provider's note can carry
 *     the risk tier and provider analysis id — compliance signals are
 *     SUPER_ADMIN-only (see AdminController's compliance-signals route)
 *     and must not tip off the subject of a review.
 *   - custodyReference / broadcastByAdminId: provider transaction ids and
 *     internal admin user ids — nothing the user can act on.
 *   - failureReason: only meaningful to the user once the withdrawal has
 *     actually FAILED or been REJECTED (their funds were released and they
 *     deserve the reason). While EXECUTION_AMBIGUOUS or later resolved, it
 *     can hold a provider error or an operator's internal note.
 * complianceDecision (PASS/BLOCKED/DEFERRED) stays: it is coarse and the
 * UI already renders DEFERRED honestly.
 */
export function toUserWithdrawalView<T extends Withdrawal>(withdrawal: T): T {
  const failureVisible = withdrawal.status === WithdrawalStatus.FAILED || withdrawal.status === WithdrawalStatus.REJECTED;
  return {
    ...withdrawal,
    complianceNote: null,
    custodyReference: null,
    broadcastByAdminId: null,
    failureReason: failureVisible ? withdrawal.failureReason : null,
  };
}
