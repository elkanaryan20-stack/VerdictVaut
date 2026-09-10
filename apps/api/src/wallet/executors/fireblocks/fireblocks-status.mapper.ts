import { WithdrawalExecutionResult, WithdrawalExecutorStatusLookup } from "../withdrawal-executor.interface";

// Fireblocks' own documented transaction status enum — VERIFIED against
// https://developers.fireblocks.com/reference/statuses (Phase 14B
// research pass). Listed explicitly (not "anything else defaults to
// X") so an unrecognized future status from a live API response is a
// visible bug to fix, never silently misclassified.
const PENDING_STATUSES = new Set([
  "SUBMITTED",
  "PENDING_AML_SCREENING",
  "PENDING_ENRICHMENT",
  "PENDING_AUTHORIZATION",
  "QUEUED",
  "PENDING_SIGNATURE",
  "SIGNED",
  "PENDING_3RD_PARTY_MANUAL_APPROVAL",
  "PENDING_3RD_PARTY",
  "CANCELLING",
]);
// A blockchain tx hash is only meaningful from BROADCASTING onward —
// verified: everything before this is provider-internal, no broadcast
// has occurred yet.
const BROADCAST_STATUSES = new Set(["BROADCASTING", "CONFIRMING", "COMPLETED"]);
const REJECTED_STATUSES = new Set(["BLOCKED", "REJECTED", "FAILED", "CANCELLED"]);

export class UnrecognizedFireblocksStatusError extends Error {
  constructor(status: string) {
    super(
      `Fireblocks reported transaction status "${status}", which is not in this adapter's verified status list — ` +
        `refusing to guess whether this means pending/broadcast/rejected. Treat as ambiguous and investigate directly with Fireblocks.`,
    );
    this.name = "UnrecognizedFireblocksStatusError";
  }
}

export interface FireblocksTransactionSnapshot {
  id: string;
  status: string;
  txHash?: string | null;
}

/** Maps a Fireblocks transaction snapshot (from the create-transaction response OR a status lookup) into the provider-neutral execution result for the initial execute() call. */
export function mapFireblocksResponseToExecutionResult(tx: FireblocksTransactionSnapshot): WithdrawalExecutionResult {
  if (REJECTED_STATUSES.has(tx.status)) {
    // A definitive, non-ambiguous outcome — thrown as a plain error so
    // it flows through WithdrawalsService.approve()'s existing "safe to
    // retry" revert-to-APPROVED path, exactly like any other clean
    // execute() failure. Never represented as "ambiguous": we KNOW
    // nothing will broadcast from this attempt.
    throw new Error(`Fireblocks did not execute this withdrawal (status ${tx.status}, id ${tx.id}).`);
  }
  if (BROADCAST_STATUSES.has(tx.status)) {
    if (!tx.txHash) {
      // A verified-broadcast status with no txHash is exactly the kind
      // of malformed/unexpected provider response this phase's failure-
      // mode handling calls out — never fabricate one.
      return { status: "ambiguous", providerReference: tx.id, reason: `Fireblocks reported status ${tx.status} but did not include a txHash.` };
    }
    return { status: "broadcast", txHash: tx.txHash, providerReference: tx.id };
  }
  if (PENDING_STATUSES.has(tx.status)) {
    // Broadened meaning of "awaiting_manual_broadcast" for Phase 14B: no
    // txHash exists yet, and resolution may come from a human (sandbox
    // ManualBroadcastExecutor) OR from this adapter's own checkStatus()
    // being polled by WithdrawalWatcherService, OR from a verified
    // webhook delivery — see withdrawals.service.ts's
    // recordProviderBroadcast.
    return { status: "awaiting_manual_broadcast", providerReference: tx.id };
  }
  throw new UnrecognizedFireblocksStatusError(tx.status);
}

/** Maps a Fireblocks transaction snapshot into the provider-neutral status-lookup shape used to resolve an ambiguous execution or to poll a pending one. */
export function mapFireblocksResponseToStatusLookup(tx: FireblocksTransactionSnapshot): WithdrawalExecutorStatusLookup {
  if (REJECTED_STATUSES.has(tx.status)) {
    return { status: "rejected", providerReference: tx.id, reason: `Fireblocks status ${tx.status}` };
  }
  if (BROADCAST_STATUSES.has(tx.status)) {
    return tx.txHash
      ? { status: "broadcast", txHash: tx.txHash, providerReference: tx.id }
      : { status: "pending", providerReference: tx.id, reason: `Fireblocks reported status ${tx.status} but no txHash yet.` };
  }
  if (PENDING_STATUSES.has(tx.status)) {
    return { status: "pending", providerReference: tx.id };
  }
  throw new UnrecognizedFireblocksStatusError(tx.status);
}
