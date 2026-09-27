import type { WithdrawalStatus } from "@verdictvaut/shared-types";

/** CREDITED/REJECTED/FAILED/CANCELLED never transition further (see apps/api WithdrawalsService) — safe to stop polling once here. */
export function isTerminalWithdrawalStatus(status: WithdrawalStatus): boolean {
  return status === "CREDITED" || status === "REJECTED" || status === "FAILED" || status === "CANCELLED";
}

/** Only reachable before SUPER_ADMIN review has acted — see WithdrawalsService.cancel(). */
export function isCancellableWithdrawalStatus(status: WithdrawalStatus): boolean {
  return status === "REQUESTED" || status === "RISK_REVIEW";
}

export const WITHDRAWAL_STATUS_LABEL: Record<WithdrawalStatus, string> = {
  REQUESTED: "Requested",
  VALIDATED: "Validated",
  RISK_REVIEW: "Pending review",
  APPROVED: "Approved",
  PENDING_MANUAL_BROADCAST: "Awaiting broadcast",
  BROADCASTING: "Broadcasting",
  BROADCAST: "Broadcast",
  CONFIRMING: "Confirming",
  CONFIRMED: "Confirmed",
  CREDITED: "Completed",
  REJECTED: "Rejected",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
  EXECUTION_AMBIGUOUS: "Under verification",
};

export const WITHDRAWAL_STATUS_DESCRIPTION: Record<WithdrawalStatus, string> = {
  REQUESTED: "Just submitted — funds are being reserved.",
  VALIDATED: "Passed initial validation.",
  RISK_REVIEW: "Funds are reserved and this withdrawal is awaiting review by the platform.",
  APPROVED: "Approved — a broadcast attempt is in progress.",
  PENDING_MANUAL_BROADCAST: "Approved and awaiting an administrator to broadcast the transaction.",
  BROADCASTING: "The transaction is being submitted to the network.",
  BROADCAST: "Broadcast to the network — awaiting on-chain confirmations.",
  CONFIRMING: "Accumulating confirmations on-chain.",
  CONFIRMED: "Fully confirmed on-chain — final settlement in progress.",
  CREDITED: "Complete — funds have left the platform.",
  REJECTED: "Rejected before broadcast — your reserved funds were released.",
  FAILED: "This withdrawal failed — your reserved funds were released.",
  CANCELLED: "You cancelled this withdrawal — your reserved funds were released.",
  EXECUTION_AMBIGUOUS:
    "We could not confirm whether this transaction was sent. Your funds are still reserved on the platform — they are not lost — while an administrator verifies the outcome with the custody provider. You don't need to do anything, and please don't submit a duplicate withdrawal for the same funds.",
};
