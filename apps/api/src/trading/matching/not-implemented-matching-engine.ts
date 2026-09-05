import { Injectable } from "@nestjs/common";
import { MatchingEngine, OrderBookSnapshot, ProposedExecution } from "./matching-engine.interface";

/**
 * Placeholder, exactly like ProductionCustodyExecutor in the wallet
 * domain: the boundary exists and is typed, the implementation does not.
 * Wiring a real price-time-priority matcher — and the execution
 * coordinator that turns its output into Fills/reservation-consumption/
 * position updates inside the authoritative ledger — is a later phase.
 * Nothing calls this yet.
 */
@Injectable()
export class NotImplementedMatchingEngine implements MatchingEngine {
  async submit(_orderId: string): Promise<void> {
    throw new Error("MatchingEngine is not implemented yet — orders rest unmatched in this phase.");
  }

  async cancel(_orderId: string): Promise<void> {
    throw new Error("MatchingEngine is not implemented yet — orders rest unmatched in this phase.");
  }

  async match(_snapshot: OrderBookSnapshot): Promise<ProposedExecution[]> {
    throw new Error("MatchingEngine is not implemented yet — orders rest unmatched in this phase.");
  }
}
