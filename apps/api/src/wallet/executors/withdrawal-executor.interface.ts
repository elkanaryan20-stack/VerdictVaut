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
   * exists (see CustodyProviderConfig.idempotencyHeaderName), so a
   * retried call against the provider's API can't result in a second
   * broadcast either — the DB-side CAS in WithdrawalsService already
   * guarantees only one caller ever reaches execute() for a given
   * withdrawal, but a provider-side idempotency key is cheap
   * defense-in-depth against retries at the network/HTTP layer, and is
   * the ONLY safe way to resolve an "ambiguous" result below without
   * risking a double-execution.
   */
  idempotencyKey: string;
}

export type WithdrawalExecutionResult =
  | { status: "broadcast"; txHash: string; providerReference?: string }
  | { status: "awaiting_manual_broadcast"; providerReference?: string }
  /**
   * Phase 14A — the call to the provider itself failed in a way that
   * leaves it genuinely UNKNOWN whether the withdrawal was actually
   * executed (e.g. a network timeout after the provider received the
   * request, or an error response that doesn't unambiguously mean
   * "nothing happened"). This is deliberately NOT represented as a
   * thrown error: WithdrawalsService.approve() treats a thrown error as
   * "safe to retry" (reverts to APPROVED) — which would risk a real
   * double-execution here if the provider actually did act. An
   * "ambiguous" result instead moves the withdrawal to
   * EXECUTION_AMBIGUOUS, holding the reservation until a SUPER_ADMIN
   * explicitly resolves it (checkStatus() below, where implemented, or
   * out-of-band confirmation with the provider) — never a silent retry.
   */
  | { status: "ambiguous"; providerReference?: string; reason: string };

export interface WithdrawalExecutorStatusLookup {
  /**
   * Provider-SIDE status, independent of on-chain confirmation (which
   * remains CustodyProvider/chain-adapter territory, not this
   * interface): "pending" — provider has the request but hasn't acted;
   * "broadcast" — provider confirms it submitted a transaction (txHash
   * should be populated); "rejected" — provider's own policy/risk
   * engine refused it; "not_found" — the provider has no record of this
   * idempotency key at all (e.g. the original request never reached it).
   */
  status: "pending" | "broadcast" | "rejected" | "not_found";
  txHash?: string;
  providerReference?: string;
  reason?: string;
}

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
  /**
   * Optional: true if this implementation can actually handle the given
   * asset/network — checked by WithdrawalExecutorFactory BEFORE ever
   * returning this executor, so an unsupported combination (e.g. an
   * asset a given custody provider doesn't cover) fails fast and
   * explicitly rather than surfacing deep inside execute(). Omit when
   * an implementation has no such distinction (e.g. ManualBroadcastExecutor
   * handles any asset/network the same way).
   */
  supportsAssetNetwork?(assetNetworkId: string): Promise<boolean>;

  execute(request: WithdrawalExecutionRequest): Promise<WithdrawalExecutionResult>;

  /**
   * Optional: provider-side status lookup keyed by the SAME
   * idempotencyKey passed to execute() — the mechanism for resolving an
   * "ambiguous" result (or any other reason a caller needs to ask the
   * provider directly "what happened with this request") without ever
   * blindly retrying a real money movement. Implementations with no
   * provider-side state to look up (ManualBroadcastExecutor) omit it.
   */
  checkStatus?(idempotencyKey: string): Promise<WithdrawalExecutorStatusLookup>;
}
