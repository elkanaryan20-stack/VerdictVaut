import { MatchCandidate } from "./matching-engine.interface";

/**
 * One proposed complete-set mint between two BUY orders on complementary
 * outcomes of the same (binary) market. Plain data only — see
 * ExecutionInstruction's docblock for why (same reasoning applies here).
 *
 * `idempotencyKey` is deterministic, derived only from the immutable
 * identity of the two orders — the same primitive Fill.idempotencyKey
 * uses, guarding against a retry or re-derivation double-applying the
 * same mint (enforced by the DB unique constraint on
 * CompleteSetMint.idempotencyKey, not by caller discipline).
 */
export interface MintInstruction {
  idempotencyKey: string;
  marketId: string;
  outcomeAId: string;
  outcomeBId: string;
  /** MAKER-equivalent: the resting order (its price is honored exactly). */
  buyOrderBId: string;
  /** TAKER-equivalent: the incoming order (pays exactly the complement, never worse than its own limit). */
  buyOrderAId: string;
  buyerAUserId: string;
  buyerBUserId: string;
  /** Always sums to exactly "1" with priceB. */
  priceA: string;
  priceB: string;
  quantity: string;
}

/**
 * The complementary-mint counterpart to MatchingEngine — a deterministic,
 * synchronous, side-effect-free function from (incoming BUY order, resting
 * BUY candidates on the COMPLEMENTARY outcome) to a proposed sequence of
 * mints. It never touches the database, never mutates positions/ledger
 * accounts, never creates records.
 *
 * Restricted to exactly-binary markets by construction: the caller
 * (ExecutionCoordinator) only invokes this when a market has exactly 2
 * outcomes, and only passes the OTHER outcome's resting BUY orders as
 * candidates. A 3+-outcome market's "complete set" would require an
 * atomic N-way match (one order per outcome, prices summing to 1) — a
 * fundamentally different matching problem this pairwise engine does not
 * attempt to solve; such markets simply have no minting path this phase,
 * and their SELL orders continue to require pre-existing inventory
 * exactly as before Phase 12A. This is a documented scope boundary, not
 * a silent gap: this platform's actual markets are binary YES/NO today.
 */
export interface CompleteSetMintEngine {
  match(
    marketId: string,
    outcomeAId: string,
    outcomeBId: string,
    incoming: MatchCandidate,
    restingComplementary: MatchCandidate[],
  ): MintInstruction[];
}

// TypeScript interfaces don't exist at runtime, so NestJS DI needs an
// explicit token to bind an interface to an implementation.
export const COMPLETE_SET_MINT_ENGINE = Symbol("CompleteSetMintEngine");
