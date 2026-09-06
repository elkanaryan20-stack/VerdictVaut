import { render, screen } from "@testing-library/react";
import { DepositStatusBadge } from "../components/wallet/DepositStatusBadge";

describe("DepositStatusBadge", () => {
  it.each([
    ["PENDING", "Pending"],
    ["CONFIRMED", "Confirmed"],
    ["CREDITED", "Credited"],
    ["REJECTED", "Rejected"],
    ["FAILED", "Failed"],
  ] as const)("renders the label for %s", (status, label) => {
    render(<DepositStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
