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
 * the resulting tx hash back through the admin API, which is verified
 * on-chain before the withdrawal is allowed to progress.
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
