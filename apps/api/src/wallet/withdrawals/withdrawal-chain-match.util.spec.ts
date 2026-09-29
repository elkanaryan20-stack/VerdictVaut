import { Prisma, Withdrawal } from "@prisma/client";
import { findChainMismatch } from "./withdrawal-chain-match.util";

/**
 * Phase 41 (R2) — the XRPL destination tag is part of "the destination":
 * a shared exchange address with the wrong or a missing tag pays a
 * different beneficiary, so it must block crediting exactly like a wrong
 * address does. Chains with no tag concept report `undefined` and are
 * unaffected.
 */
describe("findChainMismatch — destination tag", () => {
  function withdrawal(destinationTag: string | null): Withdrawal {
    return {
      destinationAddress: "rExchange",
      destinationTag,
      amount: new Prisma.Decimal("10"),
      fee: new Prisma.Decimal("0"),
    } as unknown as Withdrawal;
  }

  it("matches when the on-chain tag equals the recorded tag", () => {
    expect(findChainMismatch(withdrawal("12345"), { amount: "10", destinationAddress: "rExchange", destinationTag: "12345" })).toBeNull();
  });

  it("matches when neither side carries a tag", () => {
    expect(findChainMismatch(withdrawal(null), { amount: "10", destinationAddress: "rExchange", destinationTag: null })).toBeNull();
  });

  it("refuses a different tag on the right address", () => {
    expect(findChainMismatch(withdrawal("12345"), { amount: "10", destinationAddress: "rExchange", destinationTag: "99999" })).toMatch(/destination tag/);
  });

  it("refuses a transaction that dropped the recorded tag", () => {
    expect(findChainMismatch(withdrawal("12345"), { amount: "10", destinationAddress: "rExchange", destinationTag: null })).toMatch(/destination tag/);
  });

  it("refuses a tag the withdrawal never recorded", () => {
    expect(findChainMismatch(withdrawal(null), { amount: "10", destinationAddress: "rExchange", destinationTag: "7" })).toMatch(/destination tag/);
  });

  it("skips the tag check for chains that do not report tags (undefined)", () => {
    expect(findChainMismatch(withdrawal("12345"), { amount: "10", destinationAddress: "rExchange" })).toBeNull();
  });
});
