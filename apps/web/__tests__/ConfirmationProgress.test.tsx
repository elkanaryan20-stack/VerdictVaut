import { render, screen } from "@testing-library/react";
import { ConfirmationProgress } from "../components/wallet/ConfirmationProgress";

describe("ConfirmationProgress", () => {
  it("renders exactly the confirmations/requiredConfirmations the backend reported", () => {
    render(<ConfirmationProgress confirmations={3} requiredConfirmations={12} />);
    expect(screen.getByText("3 / 12 confirmations")).toBeInTheDocument();
  });

  it("exposes an accessible progressbar with matching aria values", () => {
    render(<ConfirmationProgress confirmations={5} requiredConfirmations={10} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "5");
    expect(bar).toHaveAttribute("aria-valuemax", "10");
  });

  it("never renders more than 100% even if confirmations exceed the requirement", () => {
    render(<ConfirmationProgress confirmations={20} requiredConfirmations={12} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });
});
