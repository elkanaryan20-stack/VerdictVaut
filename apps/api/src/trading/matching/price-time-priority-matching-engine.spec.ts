import { Prisma } from "@prisma/client";
import { MatchCandidate } from "./matching-engine.interface";
import { PriceTimePriorityMatchingEngine } from "./price-time-priority-matching-engine";

function candidate(overrides: Partial<MatchCandidate> & Pick<MatchCandidate, "orderId" | "userId" | "side">): MatchCandidate {
  return {
    price: new Prisma.Decimal("0.5"),
    remainingQuantity: new Prisma.Decimal("10"),
    sequence: 1n,
    ...overrides,
  };
}

describe("PriceTimePriorityMatchingEngine", () => {
  let engine: PriceTimePriorityMatchingEngine;

  beforeEach(() => {
    engine = new PriceTimePriorityMatchingEngine();
  });

  it("produces no executions when prices do not cross", () => {
    const incoming = candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", price: new Prisma.Decimal("0.4"), sequence: 2n });
    const resting = [candidate({ orderId: "sell-1", userId: "seller", side: "SELL", price: new Prisma.Decimal("0.6"), sequence: 1n })];

    expect(engine.match("m1", "o1", incoming, resting)).toEqual([]);
  });

  it("produces a simple full fill when an incoming order exactly matches a resting order", () => {
    const incoming = candidate({
      orderId: "buy-1",
      userId: "buyer",
      side: "BUY",
      price: new Prisma.Decimal("0.5"),
      remainingQuantity: new Prisma.Decimal("10"),
      sequence: 2n,
    });
    const resting = [
      candidate({
        orderId: "sell-1",
        userId: "seller",
        side: "SELL",
        price: new Prisma.Decimal("0.5"),
        remainingQuantity: new Prisma.Decimal("10"),
        sequence: 1n,
      }),
    ];

    const instructions = engine.match("m1", "o1", incoming, resting);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toMatchObject({
      buyOrderId: "buy-1",
      sellOrderId: "sell-1",
      makerOrderId: "sell-1",
      takerOrderId: "buy-1",
      buyerUserId: "buyer",
      sellerUserId: "seller",
      price: "0.5",
      quantity: "10",
    });
  });

  it("produces a partial fill when the incoming order is larger than the resting order", () => {
    const incoming = candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", remainingQuantity: new Prisma.Decimal("30"), sequence: 2n });
    const resting = [
      candidate({ orderId: "sell-1", userId: "seller", side: "SELL", remainingQuantity: new Prisma.Decimal("10"), sequence: 1n }),
    ];

    const instructions = engine.match("m1", "o1", incoming, resting);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].quantity).toBe("10"); // only what the resting order has
  });

  it("consumes multiple resting price levels in sequence until fully filled", () => {
    const incoming = candidate({
      orderId: "buy-1",
      userId: "buyer",
      side: "BUY",
      price: new Prisma.Decimal("0.7"),
      remainingQuantity: new Prisma.Decimal("25"),
      sequence: 3n,
    });
    const resting = [
      candidate({ orderId: "sell-1", userId: "s1", side: "SELL", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n }),
      candidate({ orderId: "sell-2", userId: "s2", side: "SELL", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n }),
      candidate({ orderId: "sell-3", userId: "s3", side: "SELL", price: new Prisma.Decimal("0.65"), remainingQuantity: new Prisma.Decimal("10"), sequence: 3n }),
    ];

    const instructions = engine.match("m1", "o1", incoming, resting);
    // Best price (lowest ask) first: 0.5 then 0.6, consuming 10+10=20, then
    // 5 from the 0.65 level to reach the incoming order's full 25.
    expect(instructions.map((i) => [i.makerOrderId, i.price, i.quantity])).toEqual([
      ["sell-1", "0.5", "10"],
      ["sell-2", "0.6", "10"],
      ["sell-3", "0.65", "5"],
    ]);
  });

  it("respects price-time priority: better price wins regardless of arrival order", () => {
    const incoming = candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", price: new Prisma.Decimal("0.7"), remainingQuantity: new Prisma.Decimal("5"), sequence: 3n });
    const resting = [
      // Worse price arrived first...
      candidate({ orderId: "sell-1", userId: "s1", side: "SELL", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n }),
      // ...but this better price, arriving later, must still be matched first.
      candidate({ orderId: "sell-2", userId: "s2", side: "SELL", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n }),
    ];

    const instructions = engine.match("m1", "o1", incoming, resting);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].makerOrderId).toBe("sell-2");
    expect(instructions[0].price).toBe("0.5");
  });

  it("execution price is always the resting order's price, never the incoming order's price or a midpoint", () => {
    const incoming = candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", price: new Prisma.Decimal("0.7"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n });
    const resting = [
      candidate({ orderId: "sell-1", userId: "seller", side: "SELL", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n }),
    ];

    const instructions = engine.match("m1", "o1", incoming, resting);
    expect(instructions[0].price).toBe("0.6"); // not "0.7", and not the "0.65" midpoint
  });

  it("same-price levels are matched in strict FIFO order by sequence, never reversed", () => {
    // SELL A 20@.60 rests first, SELL B 20@.60 rests second; an incoming
    // BUY 30@.65 must take 20 from A then 10 from B — never the reverse.
    const incoming = candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", price: new Prisma.Decimal("0.65"), remainingQuantity: new Prisma.Decimal("30"), sequence: 3n });
    const resting = [
      candidate({ orderId: "sell-A", userId: "sA", side: "SELL", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("20"), sequence: 1n }),
      candidate({ orderId: "sell-B", userId: "sB", side: "SELL", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("20"), sequence: 2n }),
    ];

    const instructions = engine.match("m1", "o1", incoming, resting);
    expect(instructions).toEqual([
      expect.objectContaining({ makerOrderId: "sell-A", quantity: "20" }),
      expect.objectContaining({ makerOrderId: "sell-B", quantity: "10" }),
    ]);
  });

  it("prevents self-trading: a user's own resting order is never matched against their incoming order", () => {
    const incoming = candidate({ orderId: "buy-1", userId: "same-user", side: "BUY", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10"), sequence: 3n });
    const resting = [
      candidate({ orderId: "sell-own", userId: "same-user", side: "SELL", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n }),
      candidate({ orderId: "sell-other", userId: "other-user", side: "SELL", price: new Prisma.Decimal("0.55"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n }),
    ];

    const instructions = engine.match("m1", "o1", incoming, resting);
    expect(instructions).toHaveLength(1);
    expect(instructions[0].makerOrderId).toBe("sell-other"); // the better-priced own order is skipped entirely
  });

  it("classifies maker (resting) and taker (incoming) correctly regardless of which side is BUY or SELL", () => {
    // Incoming SELL crossing a resting BUY: the resting BUY is the maker.
    const incoming = candidate({ orderId: "sell-1", userId: "seller", side: "SELL", price: new Prisma.Decimal("0.4"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n });
    const resting = [
      candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n }),
    ];

    const instructions = engine.match("m1", "o1", incoming, resting);
    expect(instructions[0]).toMatchObject({
      makerOrderId: "buy-1",
      takerOrderId: "sell-1",
      buyOrderId: "buy-1",
      sellOrderId: "sell-1",
      price: "0.5", // maker (resting BUY)'s price
    });
  });

  it("produces a deterministic idempotency key derived only from the (maker, taker) order-identity pair", () => {
    const incoming = candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", remainingQuantity: new Prisma.Decimal("10"), sequence: 2n });
    const resting = [candidate({ orderId: "sell-1", userId: "seller", side: "SELL", remainingQuantity: new Prisma.Decimal("10"), sequence: 1n })];

    const first = engine.match("m1", "o1", incoming, resting);
    const second = engine.match("m1", "o1", incoming, resting); // re-derived from an identical snapshot
    expect(first[0].idempotencyKey).toBe(second[0].idempotencyKey);
    expect(first[0].idempotencyKey).toBe("fill:sell-1:buy-1");
  });

  it("uses exact Decimal arithmetic — never floating point — for prices that are not exactly representable in binary", () => {
    const incoming = candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", price: new Prisma.Decimal("0.3"), remainingQuantity: new Prisma.Decimal("3"), sequence: 2n });
    const resting = [
      candidate({ orderId: "sell-1", userId: "seller", side: "SELL", price: new Prisma.Decimal("0.1"), remainingQuantity: new Prisma.Decimal("3"), sequence: 1n }),
    ];

    // 0.1 + 0.2 famously != 0.3 in IEEE-754 floating point; Decimal keeps this exact.
    const instructions = engine.match("m1", "o1", incoming, resting);
    expect(instructions[0].price).toBe("0.1");
    expect(new Prisma.Decimal(instructions[0].price).plus("0.2").toString()).toBe("0.3");
  });

  it("produces multiple fills from one incoming order sweeping several resting orders", () => {
    const incoming = candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("15"), sequence: 4n });
    const resting = [
      candidate({ orderId: "sell-1", userId: "s1", side: "SELL", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("5"), sequence: 1n }),
      candidate({ orderId: "sell-2", userId: "s2", side: "SELL", price: new Prisma.Decimal("0.55"), remainingQuantity: new Prisma.Decimal("5"), sequence: 2n }),
      candidate({ orderId: "sell-3", userId: "s3", side: "SELL", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("5"), sequence: 3n }),
    ];

    const instructions = engine.match("m1", "o1", incoming, resting);
    expect(instructions).toHaveLength(3);
    expect(instructions.reduce((sum, i) => sum.plus(i.quantity), new Prisma.Decimal(0)).toString()).toBe("15");
  });

  it("never matches BUY against BUY or SELL against SELL, even if accidentally included in the candidate list", () => {
    const incoming = candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n });
    // A same-side order (BUY) mistakenly passed in as a "resting opposite" candidate.
    const resting = [candidate({ orderId: "buy-2", userId: "other", side: "BUY", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n })];

    expect(engine.match("m1", "o1", incoming, resting)).toEqual([]);
  });

  it("stops once quantity is exhausted, leaving no instruction for unnecessary remaining candidates", () => {
    const incoming = candidate({ orderId: "buy-1", userId: "buyer", side: "BUY", price: new Prisma.Decimal("0.6"), remainingQuantity: new Prisma.Decimal("10"), sequence: 3n });
    const resting = [
      candidate({ orderId: "sell-1", userId: "s1", side: "SELL", price: new Prisma.Decimal("0.5"), remainingQuantity: new Prisma.Decimal("10"), sequence: 1n }),
      candidate({ orderId: "sell-2", userId: "s2", side: "SELL", price: new Prisma.Decimal("0.55"), remainingQuantity: new Prisma.Decimal("10"), sequence: 2n }),
    ];

    const instructions = engine.match("m1", "o1", incoming, resting);
    expect(instructions).toHaveLength(1); // fully filled by sell-1 alone; sell-2 untouched
  });
});
