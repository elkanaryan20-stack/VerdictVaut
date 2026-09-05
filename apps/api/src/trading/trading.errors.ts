export class InsufficientPositionError extends Error {
  constructor(positionId: string, available: string, requested: string) {
    super(`Insufficient outcome shares on position ${positionId}: available=${available}, requested=${requested}`);
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
