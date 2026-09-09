import { Prisma } from "@prisma/client";
import { MatchCandidate } from "./matching-engine.interface";
import { PriceTimePriorityCompleteSetMintEngine } from "./complete-set-mint-engine";

function candidate(overrides: Partial<MatchCandidate> & Pick<MatchCandidate, "orderId" | "userId">): MatchCandidate {
  return {
    side: "BUY",
    price: new Prisma.Decimal("0.5"),
    remainingQuantity: new Prisma.Decimal("10"),
    sequence: 1n,
    ...overrides,
  };
}

describe("PriceTimePriorityCompleteSetMintEngine", () => {
  let engine: PriceTimePriorityCompleteSetMintEngine;

  beforeEach(() => {
    engine = new PriceTimePriorityCompleteSetMintEngine();
  });

  it("produces no mint when combined prices are below 1", () => {
    const incoming = candidate({ orderId: "buy-a", userId: "buyerA", price: new Prisma.Decimal("0.4"), sequence: 2n });
    const resting = [candidate({ orderId: "buy-b", userId: "buyerB", price: new Prisma.Decimal("0.55"), sequence: 1n })];

    expect(engine.match("m1", "yes", "no", incoming, resting)).toEqual([]);
  });

  it("mints when combined prices exactly equal 1", () => {
    const incoming = candidate({ orderId: "buy-a", userId: "buyerA", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n });
    const resting = [candidate({ orderId: "buy-b", userId: "buyerB", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n })];

    const instructions = engine.match("m1", "yes", "no", incoming, resting);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toMatchObject({
      marketId: "m1",
      outcomeAId: "yes",
      outcomeBId: "no",
      buyOrderAId: "buy-a",
      buyOrderBId: "buy-b",
      buyerAUserId: "buyerA",
      buyerBUserId: "buyerB",
      priceA: "0.6",
      priceB: "0.4",
      quantity: "10",
    });
  });

  it("the resting (maker) price is honored exactly; the incoming (taker) side pays exactly the complement, never its own worse limit", () => {
    // Incoming is willing to pay up to 0.7, but the resting order only
    // needs 0.4 to complete $1 — the incoming side gets price improvement.
    const incoming = candidate({ orderId: "buy-a", userId: "buyerA", price: new Prisma.Decimal("0.7"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n });
    const resting = [candidate({ orderId: "buy-b", userId: "buyerB", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n })];

    const instructions = engine.match("m1", "yes", "no", incoming, resting);
    expect(instructions[0].priceA).toBe("0.6"); // 1 - 0.4, not 0.7
    expect(instructions[0].priceB).toBe("0.4"); // maker's own price, exactly
    expect(new Prisma.Decimal(instructions[0].priceA).plus(instructions[0].priceB).toString()).toBe("1");
  });

  it("produces a partial fill when the incoming order is larger than the resting order", () => {
    const incoming = candidate({ orderId: "buy-a", userId: "buyerA", remainingQuantity: new Prisma.Decimal("30"), sequence: 2n });
    const resting = [candidate({ orderId: "buy-b", userId: "buyerB", remainingQuantity: new Prisma.Decimal("10"), sequence: 1n })];

    const instructions = engine.match("m1", "yes", "no", incoming, resting);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].quantity).toBe("10");
  });

  it("prefers the resting order with the highest price first (best price for the incoming side)", () => {
    const incoming = candidate({ orderId: "buy-a", userId: "buyerA", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("5"), sequence: 3n });
    const resting = [
      candidate({ orderId: "buy-low", userId: "u1", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n }),
      candidate({ orderId: "buy-high", userId: "u2", price: new Prisma.Decimal("0.45"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n }),
    ];

    const instructions = engine.match("m1", "yes", "no", incoming, resting);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].buyOrderBId).toBe("buy-high");
    expect(instructions[0].priceB).toBe("0.45");
  });

  it("sweeps multiple resting orders best-price-first until the incoming quantity is exhausted", () => {
    const incoming = candidate({ orderId: "buy-a", userId: "buyerA", price: new Prisma.Decimal("0.7"), remainingQuantity: new Prisma.Decimal("25"), sequence: 4n });
    const resting = [
      candidate({ orderId: "buy-1", userId: "u1", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n }),
      candidate({ orderId: "buy-2", userId: "u2", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n }),
      candidate({ orderId: "buy-3", userId: "u3", price: new Prisma.Decimal("0.3"), remainingQuantity: new Prisma.Decimal("10"), sequence: 3n }),
    ];

    const instructions = engine.match("m1", "yes", "no", incoming, resting);
    // 0.3 alone doesn't cross (0.7+0.3=1.0 — actually crosses too, boundary case); best price first: 0.5, then 0.4, then 0.3.
    expect(instructions.map((i) => [i.buyOrderBId, i.quantity])).toEqual([
      ["buy-1", "10"],
      ["buy-2", "10"],
      ["buy-3", "5"],
    ]);
  });

  it("prevents self-minting: a user's own resting order is never matched against their incoming order", () => {
    const incoming = candidate({ orderId: "buy-a", userId: "same-user", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10"), sequence: 3n });
    const resting = [
      candidate({ orderId: "buy-own", userId: "same-user", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n }),
      candidate({ orderId: "buy-other", userId: "other-user", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n }),
    ];

    const instructions = engine.match("m1", "yes", "no", incoming, resting);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].buyOrderBId).toBe("buy-other");
  });

  it("ignores a non-BUY candidate even if mistakenly included", () => {
    const incoming = candidate({ orderId: "buy-a", userId: "buyerA", price: new Prisma.Decimal("0.6"), sequence: 2n });
    const resting = [candidate({ orderId: "sell-b", userId: "buyerB", side: "SELL", price: new Prisma.Decimal("0.4"), sequence: 1n })];

    expect(engine.match("m1", "yes", "no", incoming, resting)).toEqual([]);
  });

  it("produces a deterministic idempotency key derived only from the (maker, taker) order-identity pair", () => {
    const incoming = candidate({ orderId: "buy-a", userId: "buyerA", price: new Prisma.Decimal("0.6"), sequence: 2n });
    const resting = [candidate({ orderId: "buy-b", userId: "buyerB", price: new Prisma.Decimal("0.4"), sequence: 1n })];

    const first = engine.match("m1", "yes", "no", incoming, resting);
    const second = engine.match("m1", "yes", "no", incoming, resting);
    expect(first[0].idempotencyKey).toBe(second[0].idempotencyKey);
    expect(first[0].idempotencyKey).toBe("mint:buy-b:buy-a");
  });

  it("uses exact Decimal arithmetic — never floating point", () => {
    const incoming = candidate({ orderId: "buy-a", userId: "buyerA", price: new Prisma.Decimal("0.3"), remainingQuantity: new Prisma.Decimal("3"), sequence: 2n });
    const resting = [candidate({ orderId: "buy-b", userId: "buyerB", price: new Prisma.Decimal("0.7"), remainingQuantity: new Prisma.Decimal("3"), sequence: 1n })];

    const instructions = engine.match("m1", "yes", "no", incoming, resting);
    expect(instructions[0].priceA).toBe("0.3"); // exactly the complement of 0.7, no float drift
  });
});
