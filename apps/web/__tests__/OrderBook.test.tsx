import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OrderBook } from "../components/trading/OrderBook";

describe("OrderBook", () => {
  it("renders bids and asks in the order the backend already sorted them (highest bid first, lowest ask first)", () => {
    render(
      <OrderBook
        book={{
          bids: [
            { price: "0.6", quantity: "10" },
            { price: "0.55", quantity: "20" },
          ],
          asks: [
            { price: "0.65", quantity: "5" },
            { price: "0.7", quantity: "8" },
          ],
          asOf: new Date().toISOString(),
        }}
        isLoading={false}
        isError={false}
        onRetry={jest.fn()}
      />,
    );

    const prices = screen.getAllByText(/^0\.\d+$/).map((el) => el.textContent);
    expect(prices).toEqual(["0.6", "0.55", "0.65", "0.7"]);
  });

  it("shows a distinct empty message per side when one side has no resting orders", () => {
    render(
      <OrderBook
        book={{ bids: [], asks: [{ price: "0.5", quantity: "1" }], asOf: new Date().toISOString() }}
        isLoading={false}
        isError={false}
        onRetry={jest.fn()}
      />,
    );
    expect(screen.getByText("No orders")).toBeInTheDocument();
    expect(screen.getByText("0.5")).toBeInTheDocument();
  });

  it("shows a retry control on error", async () => {
    const onRetry = jest.fn();
    const user = userEvent.setup();
    render(<OrderBook book={undefined} isLoading={false} isError={true} onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("renders loading skeletons and no data while loading", () => {
    render(
      <OrderBook
        book={{ bids: [{ price: "0.5", quantity: "1" }], asks: [], asOf: new Date().toISOString() }}
        isLoading={true}
        isError={false}
        onRetry={jest.fn()}
      />,
    );
    expect(screen.queryByText("0.5")).not.toBeInTheDocument();
  });
});
