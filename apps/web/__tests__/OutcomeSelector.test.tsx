import type { MarketOutcome } from "@verdictvaut/shared-types";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutcomeSelector } from "../components/markets/OutcomeSelector";

function outcome(overrides: Partial<MarketOutcome>): MarketOutcome {
  return {
    id: "outcome-yes",
    marketId: "market-1",
    key: "YES",
    label: "Yes",
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("OutcomeSelector", () => {
  it("selects by outcome id, not label — two outcomes sharing a label stay distinguishable", async () => {
    const outcomes = [
      outcome({ id: "outcome-a", label: "Yes", sortOrder: 0 }),
      outcome({ id: "outcome-b", label: "Yes", sortOrder: 1 }),
    ];
    const onSelect = jest.fn();
    const user = userEvent.setup();

    render(<OutcomeSelector outcomes={outcomes} selectedOutcomeId="outcome-a" onSelect={onSelect} />);

    const radios = screen.getAllByRole("radio", { name: "Yes" });
    expect(radios).toHaveLength(2);
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[1]).toHaveAttribute("aria-checked", "false");

    await user.click(radios[1]);
    expect(onSelect).toHaveBeenCalledWith("outcome-b");
  });

  it("renders outcomes in sortOrder regardless of array order", () => {
    const outcomes = [outcome({ id: "outcome-no", label: "No", sortOrder: 1 }), outcome({ id: "outcome-yes", label: "Yes", sortOrder: 0 })];
    render(<OutcomeSelector outcomes={outcomes} selectedOutcomeId={null} onSelect={jest.fn()} />);

    const radios = screen.getAllByRole("radio");
    expect(radios[0]).toHaveTextContent("Yes");
    expect(radios[1]).toHaveTextContent("No");
  });
});
