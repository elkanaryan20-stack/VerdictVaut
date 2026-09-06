import { BadRequestException } from "@nestjs/common";

/**
 * Extends BadRequestException — see InsufficientBalanceError's docblock
 * in ledger/ledger.errors.ts for the full reasoning: this used to fall
 * through as a generic 500, making an ordinary "you don't have enough
 * shares to sell" outcome indistinguishable from a server fault.
 */
export class InsufficientPositionError extends BadRequestException {
  constructor(
    public readonly positionId: string,
    public readonly available: string,
    public readonly requested: string,
  ) {
    super("Insufficient available position quantity to complete this request.");
    this.name = "InsufficientPositionError";
  }
}

/**
 * Thrown when an order was successfully funded and created, but the
 * immediately-following matching attempt (ExecutionCoordinator.matchAndExecute)
 * threw. The order and its reservation are NOT rolled back by this — they
 * were already committed in their own transaction before matching ever ran
 * (see OrdersService.create's docblock) — so `orderId` always refers to a
 * real, correctly-funded, resting order. This exists so a matching-layer
 * failure can never be silently swallowed into an ordinary success
 * response: callers must handle it explicitly (see TradingController),
 * typically by reporting the order as accepted with matching deferred, and
 * pointing the caller at OrdersService.retryMatching to recover.
 */
export class MatchingAttemptFailedException extends Error {
  constructor(
    public readonly orderId: string,
    public readonly matchingError: unknown,
  ) {
    super(
      `Order ${orderId} was placed and funded successfully, but the immediate matching attempt failed: ${
        matchingError instanceof Error ? matchingError.message : String(matchingError)
      }`,
    );
    this.name = "MatchingAttemptFailedException";
  }
}
