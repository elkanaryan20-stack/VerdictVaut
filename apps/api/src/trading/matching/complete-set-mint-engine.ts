import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { CompleteSetMintEngine, MintInstruction } from "./complete-set-mint-engine.interface";
import { MatchCandidate } from "./matching-engine.interface";

const ONE = new Prisma.Decimal(1);

/**
 * Same-side (BUY-vs-BUY) complementary matching — see the interface
 * docblock for the economics. Self-mint policy mirrors
 * PriceTimePriorityMatchingEngine's self-trade policy exactly, for the
 * same reasoning: a user's own resting order is never matched against
 * their own incoming order, even though self-minting would be economically
 * harmless here (no counterparty is deceived, no fee is avoided since
 * minting charges none) — consistency with the platform's one established
 * self-dealing policy is worth more than the marginal convenience.
 */
@Injectable()
export class PriceTimePriorityCompleteSetMintEngine implements CompleteSetMintEngine {
  match(
    marketId: string,
    outcomeAId: string,
    outcomeBId: string,
    incoming: MatchCandidate,
    restingComplementary: MatchCandidate[],
  ): MintInstruction[] {
    const eligible = restingComplementary
      .filter((resting) => resting.side === "BUY")
      .filter((resting) => resting.userId !== incoming.userId)
      // Best price first: a higher resting priceB leaves more room to
      // cross (combined >= 1) and gives the incoming side a better
      // (lower) price — the direct mint analogue of price-time priority.
      .sort((a, b) => comparePriority(a, b));

    const instructions: MintInstruction[] = [];
    let remaining = incoming.remainingQuantity;

    for (const resting of eligible) {
      if (remaining.lessThanOrEqualTo(0)) break;
      if (resting.remainingQuantity.lessThanOrEqualTo(0)) continue;

      const combined = incoming.price.plus(resting.price);
      // Sorted best-price-first: once one resting order can't reach 1
      // combined with the incoming price, every later (lower-priced) one
      // fails too.
      if (combined.lessThan(ONE)) break;

      const executionQuantity = Prisma.Decimal.min(remaining, resting.remainingQuantity);
      // The resting (maker) order's price is honored exactly; the
      // incoming (taker) order pays exactly the complement — never more
      // than its own limit allowed (combined >= 1 guarantees priceA-here
      // <= incoming.price), and any gap is the incoming side's price
      // improvement, never destroyed. This is what guarantees
      // complete_set_mints_price_sum_check (priceA + priceB = 1) holds
      // for every mint this engine ever proposes.
      const priceB = resting.price;
      const priceA = ONE.minus(priceB);

      instructions.push({
        idempotencyKey: `mint:${resting.orderId}:${incoming.orderId}`,
        marketId,
        outcomeAId,
        outcomeBId,
        buyOrderAId: incoming.orderId,
        buyOrderBId: resting.orderId,
        buyerAUserId: incoming.userId,
        buyerBUserId: resting.userId,
        priceA: priceA.toString(),
        priceB: priceB.toString(),
        quantity: executionQuantity.toString(),
      });

      remaining = remaining.minus(executionQuantity);
    }

    return instructions;
  }
}

function comparePriority(a: MatchCandidate, b: MatchCandidate): number {
  const priceCmp = b.price.comparedTo(a.price); // higher price first
  if (priceCmp !== 0) return priceCmp;
  if (a.sequence < b.sequence) return -1; // earliest sequence (FIFO) wins
  if (a.sequence > b.sequence) return 1;
  return 0;
}
