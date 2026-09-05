/**
 * Thrown when SettlementService.settleMarket fails partway through a
 * market's payout run — after ResolutionService already committed the
 * outcome decision (MarketResolution + per-outcome Settlement rows,
 * CLOSED -> RESOLVING). That decision is never rolled back by this: it
 * already committed in its own transaction. Whatever individual
 * positions DID settle before the failure stay settled (each is its own
 * transaction) — this exists so a failure can never be silently
 * swallowed into a false "fully resolved" response, mirroring
 * MatchingAttemptFailedException's role in the trading/execution layer.
 * Recovery is ResolutionService.retrySettlement / SettlementService
 * .settleMarket again — safe to call any number of times.
 */
export class SettlementAttemptFailedException extends Error {
  constructor(
    public readonly marketId: string,
    public readonly settlementError: unknown,
  ) {
    super(
      `Market ${marketId}'s resolution was recorded, but settlement failed partway through: ${
        settlementError instanceof Error ? settlementError.message : String(settlementError)
      }`,
    );
    this.name = "SettlementAttemptFailedException";
  }
}
