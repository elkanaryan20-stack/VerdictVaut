export class InsufficientBalanceError extends Error {
  constructor(accountId: string, currentBalance: string, requestedAmount: string) {
    super(
      `Insufficient balance on account ${accountId}: balance=${currentBalance}, requested=${requestedAmount}`,
    );
    this.name = "InsufficientBalanceError";
  }
}
