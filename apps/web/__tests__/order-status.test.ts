import { isCancellableOrderStatus, isMarketTradable, isTerminalOrderStatus } from "../lib/trading/order-status";

describe("isTerminalOrderStatus", () => {
  it.each(["FILLED", "CANCELLED", "EXPIRED", "REJECTED"] as const)("%s is terminal", (status) => {
    expect(isTerminalOrderStatus(status)).toBe(true);
  });

  it.each(["OPEN", "PARTIALLY_FILLED"] as const)("%s is not terminal", (status) => {
    expect(isTerminalOrderStatus(status)).toBe(false);
  });
});

describe("isCancellableOrderStatus", () => {
  it.each(["OPEN", "PARTIALLY_FILLED"] as const)("%s is cancellable", (status) => {
    expect(isCancellableOrderStatus(status)).toBe(true);
  });

  it.each(["FILLED", "CANCELLED", "EXPIRED", "REJECTED"] as const)("%s is not cancellable", (status) => {
    expect(isCancellableOrderStatus(status)).toBe(false);
  });
});

describe("isMarketTradable", () => {
  it("only OPEN markets are tradable", () => {
    expect(isMarketTradable("OPEN")).toBe(true);
    expect(isMarketTradable("CLOSED")).toBe(false);
    expect(isMarketTradable("RESOLVING")).toBe(false);
    expect(isMarketTradable("RESOLVED")).toBe(false);
    expect(isMarketTradable("DRAFT")).toBe(false);
    expect(isMarketTradable("PAUSED")).toBe(false);
    expect(isMarketTradable("CANCELLED")).toBe(false);
  });
});
