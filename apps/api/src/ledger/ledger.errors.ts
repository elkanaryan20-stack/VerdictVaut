import { BadRequestException } from "@nestjs/common";

/**
 * Extends BadRequestException (not plain Error) so this reaches HTTP
 * clients as a real 400 with a clean, user-safe message — previously it
 * fell through AllExceptionsFilter's generic "Internal server error" 500
 * path, making a completely ordinary "you don't have enough balance"
 * outcome indistinguishable from a genuine server fault. The internal
 * account id and figures are kept as readable properties for
 * server-side logging/debugging, never interpolated into the message
 * sent to the client. instanceof/toThrow(InsufficientBalanceError)
 * checks throughout the test suite are unaffected by this base-class
 * change — only what gets serialized over HTTP changes.
 */
export class InsufficientBalanceError extends BadRequestException {
  constructor(
    public readonly accountId: string,
    public readonly currentBalance: string,
    public readonly requestedAmount: string,
  ) {
    super("Insufficient available balance to complete this request.");
    this.name = "InsufficientBalanceError";
  }
}

/**
 * Deliberately left as a plain Error, not an HttpException: this
 * represents postings that don't sum to zero, which can only happen from
 * a bug in the calling code (a caller-computed set of postings), never
 * from anything a client submitted. Surfacing it to an HTTP client as a
 * "bad request" would be both meaningless to them and misleading — it is
 * correctly opaque as an Internal server error, while still being fully
 * detailed for server-side logs.
 */
export class UnbalancedTransactionError extends Error {
  constructor(assetId: string, sum: string) {
    super(`Ledger transaction postings for asset ${assetId} do not sum to zero (got ${sum})`);
    this.name = "UnbalancedTransactionError";
  }
}

/** See InsufficientBalanceError's docblock — same reasoning, same fix. */
export class InvalidReservationAmountError extends BadRequestException {
  constructor(public readonly amount: string) {
    super("Reservation amount must be positive.");
    this.name = "InvalidReservationAmountError";
  }
}
