export class InsufficientBalanceError extends Error {
  constructor(accountId: string, currentBalance: string, requestedAmount: string) {
    super(
      `Insufficient balance on account ${accountId}: balance=${currentBalance}, requested=${requestedAmount}`,
    );
    this.name = "InsufficientBalanceError";
  }
}

export class UnbalancedTransactionError extends Error {
  constructor(assetId: string, sum: string) {
    super(`Ledger transaction postings for asset ${assetId} do not sum to zero (got ${sum})`);
    this.name = "UnbalancedTransactionError";
  }
}

export class InvalidReservationAmountError extends Error {
  constructor(amount: string) {
    super(`Reservation amount must be positive, got ${amount}`);
    this.name = "InvalidReservationAmountError";
  }
}
