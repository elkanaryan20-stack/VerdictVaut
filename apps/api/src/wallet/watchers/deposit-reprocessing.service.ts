import { Injectable } from "@nestjs/common";
import { AuditLogService } from "../../audit/audit-log.service";
import { PrismaService } from "../../prisma/prisma.service";
import { DepositChainAdapterFactory } from "../chain-adapters/deposit-chain-adapter.factory";
import { ConfirmationPolicyService } from "../confirmation/confirmation-policy.service";
import { DepositsService } from "../deposits/deposits.service";

/**
 * The admin-facing "safe retry/reprocessing operation" (requirement #15)
 * — an on-demand, single-deposit version of what DepositWatcherService
 * does continuously. Deliberately re-derives everything (amount,
 * confirmations, destination tag) from a live chain lookup rather than
 * accepting any of it as admin input: there is intentionally no
 * parameter here an admin could use to invent or inflate a deposit. If
 * the adapter can no longer find the transaction at all and the deposit
 * was never credited, that is exactly the reorg/reversal case this
 * marks REJECTED rather than leaving to rot as PENDING forever.
 */
@Injectable()
export class DepositReprocessingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapterFactory: DepositChainAdapterFactory,
    private readonly confirmationPolicy: ConfirmationPolicyService,
    private readonly depositsService: DepositsService,
    private readonly auditLog: AuditLogService,
  ) {}

  async reprocess(depositId: string, adminId: string) {
    const deposit = await this.prisma.deposit.findUniqueOrThrow({
      where: { id: depositId },
      include: { walletAddress: true },
    });

    await this.depositsService.touchLastChecked(depositId);

    const { adapter, network } = await this.adapterFactory.resolve(deposit.assetNetworkId);
    const watched = {
      walletAddressId: deposit.walletAddressId,
      address: deposit.walletAddress.address,
      destinationTag: deposit.walletAddress.destinationTag,
    };

    const fresh = await adapter.inspectTransaction({
      network,
      address: watched,
      txHash: deposit.txHash,
      eventIndex: deposit.eventIndex,
    });

    if (!fresh) {
      const { deposit: updated, justRejected } = await this.depositsService.rejectIfNotCredited(
        depositId,
        "Admin reprocess: transaction no longer found on chain (dropped from mempool or reorged out)",
      );
      if (justRejected) {
        await this.auditLog.record({
          actorId: adminId,
          action: "deposit.reprocess.rejected",
          resourceType: "Deposit",
          resourceId: depositId,
          before: { status: deposit.status },
          after: { status: updated.status },
          idempotencyKey: `deposit:${depositId}:reprocess:${Date.now()}`,
        });
      }
      return updated;
    }

    const requiredConfirmations = await this.confirmationPolicy.getRequiredConfirmations(deposit.assetNetworkId);
    const result = await this.depositsService.recordObservedTransaction({
      userId: deposit.userId,
      assetSymbol: network.assetSymbol,
      assetNetworkId: deposit.assetNetworkId,
      walletAddressId: deposit.walletAddressId,
      txHash: fresh.txHash,
      eventIndex: fresh.eventIndex,
      amount: fresh.amount,
      confirmations: fresh.confirmations,
      requiredConfirmations,
      destinationTag: fresh.destinationTag,
      rawProviderPayload: fresh.rawProviderPayload,
    });

    await this.auditLog.record({
      actorId: adminId,
      action: "deposit.reprocess",
      resourceType: "Deposit",
      resourceId: depositId,
      before: { status: deposit.status },
      after: { status: result.status, confirmations: result.confirmations },
      idempotencyKey: `deposit:${depositId}:reprocess:${Date.now()}`,
    });

    return result;
  }
}
