import { Injectable } from "@nestjs/common";
import {
  WithdrawalExecutionRequest,
  WithdrawalExecutionResult,
  WithdrawalExecutor,
} from "./withdrawal-executor.interface";

/**
 * Placeholder for a real custody provider integration (e.g. Fireblocks,
 * Turnkey, or a self-custody signer backed by a KMS/HSM). Intentionally
 * not implemented — wiring this up is production work that comes after
 * the sandbox/testing phase, and it must never be faked. Selecting this
 * executor for an asset/network before a real provider is wired is a
 * configuration error, not something to silently paper over.
 */
@Injectable()
export class ProductionCustodyExecutor implements WithdrawalExecutor {
  async execute(_request: WithdrawalExecutionRequest): Promise<WithdrawalExecutionResult> {
    throw new Error(
      "ProductionCustodyExecutor is not implemented yet. No production custody provider is integrated — " +
        "do not route withdrawals to this executor until one is.",
    );
  }
}
