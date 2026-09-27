import { WITHDRAWAL_STATUSES, WithdrawalSchema } from "@verdictvaut/shared-types";
import { render, screen } from "@testing-library/react";
import { WithdrawalStatusBadge } from "../components/wallet/WithdrawalStatusBadge";
import { WITHDRAWAL_STATUS_DESCRIPTION, WITHDRAWAL_STATUS_LABEL, isCancellableWithdrawalStatus, isTerminalWithdrawalStatus } from "../lib/wallet/withdrawal-status";

/**
 * Phase 36 P1 regression: the backend's EXECUTION_AMBIGUOUS status
 * (Phase 14A) was missing from the shared WithdrawalStatus enum, so ONE
 * such withdrawal made the whole GET /wallet/withdrawals (and
 * GET /admin/withdrawals) response fail schema validation — the user's
 * history and the admin queue both errored out exactly when a withdrawal
 * needed attention.
 */
const base = {
  id: "wd-1",
  userId: "u-1",
  assetNetworkId: "an-1",
  destinationAddress: "0xabc",
  destinationTag: null,
  amount: "10",
  fee: "0",
  txHash: null,
  custodyReference: null,
  broadcastByAdminId: null,
  broadcastAt: null,
  confirmedAt: null,
  failureReason: null,
  complianceDecision: "DEFERRED",
  complianceNote: null,
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
};

describe("withdrawal status contract", () => {
  it("accepts a list response containing an EXECUTION_AMBIGUOUS withdrawal alongside others", () => {
    const list = [
      { ...base, id: "a", status: "RISK_REVIEW" },
      { ...base, id: "b", status: "EXECUTION_AMBIGUOUS" },
    ];
    expect(WithdrawalSchema.array().safeParse(list).success).toBe(true);
  });

  it.each(WITHDRAWAL_STATUSES)("%s has a label, a description, and renders a badge without crashing", (status) => {
    expect(WITHDRAWAL_STATUS_LABEL[status]).toBeTruthy();
    expect(WITHDRAWAL_STATUS_DESCRIPTION[status]).toBeTruthy();
    render(<WithdrawalStatusBadge status={status} />);
    expect(screen.getByText(WITHDRAWAL_STATUS_LABEL[status])).toBeInTheDocument();
  });

  it("treats EXECUTION_AMBIGUOUS as non-terminal (keeps polling) and never user-cancellable", () => {
    expect(isTerminalWithdrawalStatus("EXECUTION_AMBIGUOUS")).toBe(false);
    expect(isCancellableWithdrawalStatus("EXECUTION_AMBIGUOUS")).toBe(false);
  });

  it("describes EXECUTION_AMBIGUOUS without implying the funds are lost", () => {
    expect(WITHDRAWAL_STATUS_DESCRIPTION.EXECUTION_AMBIGUOUS).toMatch(/not lost/);
    expect(WITHDRAWAL_STATUS_DESCRIPTION.EXECUTION_AMBIGUOUS).toMatch(/still reserved/);
  });
});
