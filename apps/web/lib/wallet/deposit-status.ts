import type { DepositStatus } from "@verdictvaut/shared-types";

/** CREDITED/REJECTED/FAILED never transition further (see apps/api DepositsService) — safe to stop polling once here. */
export function isTerminalDepositStatus(status: DepositStatus): boolean {
  return status === "CREDITED" || status === "REJECTED" || status === "FAILED";
}

export const DEPOSIT_STATUS_LABEL: Record<DepositStatus, string> = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  CREDITED: "Credited",
  REJECTED: "Rejected",
  FAILED: "Failed",
};

export const DEPOSIT_STATUS_DESCRIPTION: Record<DepositStatus, string> = {
  PENDING: "Detected on chain and accumulating confirmations.",
  CONFIRMED: "Fully confirmed on chain and queued to credit your balance.",
  CREDITED: "Credited to your available balance.",
  REJECTED: "The chain no longer shows this transaction (e.g. a reorg) — it was never credited.",
  FAILED: "This deposit could not be processed automatically and needs a closer look.",
};
