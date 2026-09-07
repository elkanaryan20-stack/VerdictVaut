export interface WithdrawalExecutionRequest {
  withdrawalId: string;
  assetNetworkId: string;
  destinationAddress: string;
  destinationTag?: string | null;
  amount: string;
  /**
   * Stable idempotency key for this execution attempt — currently the
   * withdrawal id (the strongest immutable identifier this architecture
   * has for "one withdrawal, one execution"). A real custody provider
   * implementation (ProductionCustodyExecutor) should pass this straight
   * through to the provider's own idempotency-key mechanism where one
   * exists, so a retried call against the provider's API can't result in
   * a second broadcast either — the DB-side CAS in WithdrawalsService
   * already guarantees only one caller ever reaches execute() for a given
   * withdrawal, but a provider-side idempotency key is cheap
   * defense-in-depth against retries at the network/HTTP layer.
   */
  idempotencyKey: string;
}

export type WithdrawalExecutionResult =
  | { status: "broadcast"; txHash: string; custodyReference?: string }
  | { status: "awaiting_manual_broadcast"; custodyReference?: string };

/**
 * The one seam between "a withdrawal was approved" and "a transaction
 * actually left a wallet". Which implementation runs is configuration-
 * driven per asset/network/environment (see WithdrawalExecutorFactory) —
 * nothing upstream of this interface knows or cares which one is active.
 *
 * execute() must be safe to call at most once per withdrawal — the
 * caller (WithdrawalsService.approve) guarantees that via an atomic
 * compare-and-swap on the withdrawal's status before ever reaching this
 * interface, so no implementation needs its own locking, but a
 * ProductionCustodyExecutor should still treat `idempotencyKey` as a
 * belt-and-suspenders guard against its own retries.
 */
export interface WithdrawalExecutor {
  execute(request: WithdrawalExecutionRequest): Promise<WithdrawalExecutionResult>;
}
