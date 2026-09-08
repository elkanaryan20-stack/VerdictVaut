import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WithdrawalStatus } from "@prisma/client";
import { AppConfig } from "../../config/configuration";
import { PrismaService } from "../../prisma/prisma.service";
import { ConfirmationPolicyService } from "../confirmation/confirmation-policy.service";
import { CustodyProviderFactory } from "../custody/custody-provider.factory";
import { WithdrawalsService } from "../withdrawals/withdrawals.service";

/**
 * Turns "a withdrawal is BROADCAST/CONFIRMING with a real txHash" into
 * calls against WithdrawalsService.recordConfirmation() with genuinely
 * observed on-chain confirmation counts — the missing piece Phase 8's
 * audit flagged (recordConfirmation existed but nothing ever called it).
 * Mirrors DepositWatcherService's architecture exactly: read-only chain
 * I/O happens here, outside any DB transaction; it never itself mutates
 * a withdrawal's status or the ledger — WithdrawalsService.
 * recordConfirmation owns that, the same separation of concerns the
 * deposit watcher already established.
 *
 * A txHash reported "not_found" by the chain is deliberately NOT treated
 * as a failure here — a transient provider hiccup and a genuine dropped/
 * reorged broadcast look identical from this one read, and guessing
 * wrong in either direction is worse than leaving the withdrawal's state
 * untouched and requiring a SUPER_ADMIN to invoke the explicit
 * reconciliation endpoint (POST /admin/withdrawals/:id/reconcile), which
 * is read+audit only and never silently "fixes" anything either.
 *
 * Off by default (WITHDRAWAL_WATCHER_ENABLED) for the same reason the
 * deposit watcher is: importing this module must never cause an app
 * instance — including every unit and integration test — to start
 * making outbound network calls on its own.
 */
@Injectable()
export class WithdrawalWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WithdrawalWatcherService.name);
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly custodyProviderFactory: CustodyProviderFactory,
    private readonly confirmationPolicy: ConfirmationPolicyService,
    private readonly withdrawalsService: WithdrawalsService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  onModuleInit(): void {
    const config = this.configService.get("withdrawalWatcher", { infer: true });
    if (!config.enabled) {
      this.logger.log("Withdrawal confirmation watcher disabled (set WITHDRAWAL_WATCHER_ENABLED=true to start it)");
      return;
    }
    this.logger.log(`Withdrawal confirmation watcher starting — polling every ${config.pollIntervalMs}ms`);
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => this.logger.error("Unhandled error in withdrawal watcher poll", error as Error));
    }, config.pollIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One pass over every withdrawal awaiting on-chain confirmation. Each
   * withdrawal's check is caught and logged independently so one broken
   * chain integration or one bad txHash never stalls checking every
   * other withdrawal (same observability reasoning as
   * DepositWatcherService.pollOnce).
   */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const pending = await this.prisma.withdrawal.findMany({
        where: {
          status: { in: [WithdrawalStatus.BROADCAST, WithdrawalStatus.CONFIRMING] },
          txHash: { not: null },
        },
      });
      for (const withdrawal of pending) {
        try {
          await this.checkOne(withdrawal.id, withdrawal.assetNetworkId, withdrawal.txHash!);
        } catch (error) {
          this.logger.error(`Confirmation check failed for withdrawal ${withdrawal.id}`, error as Error);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async checkOne(withdrawalId: string, assetNetworkId: string, txHash: string): Promise<void> {
    const provider = await this.custodyProviderFactory.resolve(assetNetworkId);
    const status = await provider.getTransactionStatus(txHash, assetNetworkId);

    if (status.status === "not_found") {
      this.logger.warn(
        `Withdrawal ${withdrawalId}'s broadcast transaction ${txHash} was not found on-chain — leaving its state untouched; use POST /admin/withdrawals/:id/reconcile to investigate.`,
      );
      return;
    }

    // A "failed" status (requirement #12) means the chain has a final,
    // immutable record of this transaction but it did NOT deliver value
    // (an EVM revert, an XRPL tec-class result, a Solana `err`) — this
    // must never be silently ignored (which would leave the withdrawal
    // stuck CONFIRMING forever with a reservation nothing ever resolves)
    // nor treated as a reason to broadcast again (WithdrawalsService has
    // no re-broadcast path from BROADCAST/CONFIRMING at all — see its own
    // state-machine docblock). fail() releases the reservation and moves
    // the withdrawal to the terminal FAILED state, exactly the outcome a
    // genuinely failed broadcast deserves.
    if (status.status === "failed") {
      this.logger.error(`Withdrawal ${withdrawalId}'s broadcast transaction ${txHash} failed on-chain — marking the withdrawal FAILED.`);
      await this.withdrawalsService.fail(withdrawalId, `Broadcast transaction ${txHash} failed on-chain.`);
      return;
    }

    const requiredConfirmations = await this.confirmationPolicy.getRequiredConfirmations(assetNetworkId);
    await this.withdrawalsService.recordConfirmation(withdrawalId, status.confirmations, requiredConfirmations);
  }
}
