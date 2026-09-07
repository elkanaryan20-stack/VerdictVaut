import { Injectable, Logger } from "@nestjs/common";
import {
  WithdrawalExecutionRequest,
  WithdrawalExecutionResult,
  WithdrawalExecutor,
} from "./withdrawal-executor.interface";

/**
 * Sandbox default. Performs no signing and holds no key material — it
 * marks the withdrawal as waiting on a human. An admin broadcasts the
 * transaction themselves with their own wallet tooling and then submits
 * the resulting tx hash back through the admin API
 * (WithdrawalsService.recordManualBroadcast), which records it and moves
 * the withdrawal to BROADCAST.
 *
 * PHASE 8 AUDIT NOTE: recordManualBroadcast does NOT currently verify the
 * submitted txHash on-chain before that transition — it trusts the
 * SUPER_ADMIN-supplied value as-is. This is not a user-facing attack
 * surface (the caller is already the platform's single fully-trusted
 * SUPER_ADMIN authority, per the platform-control-model note), but it is
 * a real accuracy gap: a mistyped or unrelated txHash would be recorded
 * without complaint. WithdrawalsService.recordConfirmation already
 * exists as the intended follow-on step (poll the chain, confirm the
 * real transaction, then capture the reservation) but nothing calls it
 * yet — building that confirmation watcher (and having it cross-check
 * the admin-submitted txHash against real chain data before/at that
 * point) is explicit Phase 9 custody/withdrawal work, out of scope here.
 */
@Injectable()
export class ManualBroadcastExecutor implements WithdrawalExecutor {
  private readonly logger = new Logger(ManualBroadcastExecutor.name);

  async execute(request: WithdrawalExecutionRequest): Promise<WithdrawalExecutionResult> {
    this.logger.log(
      `Withdrawal ${request.withdrawalId} is awaiting manual broadcast by an admin ` +
        `(asset-network ${request.assetNetworkId}, amount ${request.amount} to ${request.destinationAddress}).`,
    );
    return { status: "awaiting_manual_broadcast" };
  }
}
