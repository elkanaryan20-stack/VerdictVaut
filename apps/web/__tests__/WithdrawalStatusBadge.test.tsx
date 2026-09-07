import { render, screen } from "@testing-library/react";
import { WithdrawalStatusBadge } from "../components/wallet/WithdrawalStatusBadge";

describe("WithdrawalStatusBadge", () => {
  it.each([
    ["REQUESTED", "Requested"],
    ["RISK_REVIEW", "Pending review"],
    ["APPROVED", "Approved"],
    ["PENDING_MANUAL_BROADCAST", "Awaiting broadcast"],
    ["BROADCAST", "Broadcast"],
    ["CONFIRMING", "Confirming"],
    ["CONFIRMED", "Confirmed"],
    ["CREDITED", "Completed"],
    ["REJECTED", "Rejected"],
    ["FAILED", "Failed"],
    ["CANCELLED", "Cancelled"],
  ] as const)("renders the label for %s", (status, label) => {
    render(<WithdrawalStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
