export interface WithdrawalExecutionRequest {
  withdrawalId: string;
  assetNetworkId: string;
  destinationAddress: string;
  destinationTag?: string | null;
  amount: string;
}

export type WithdrawalExecutionResult =
  | { status: "broadcast"; txHash: string }
  | { status: "awaiting_manual_broadcast" };

/**
 * The one seam between "a withdrawal was approved" and "a transaction
 * actually left a wallet". Which implementation runs is configuration-
 * driven per asset/network/environment (see WithdrawalExecutorFactory) —
 * nothing upstream of this interface knows or cares which one is active.
 */
export interface WithdrawalExecutor {
  execute(request: WithdrawalExecutionRequest): Promise<WithdrawalExecutionResult>;
}
