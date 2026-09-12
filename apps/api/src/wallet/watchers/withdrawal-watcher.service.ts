import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WithdrawalStatus } from "@prisma/client";
import { AppConfig } from "../../config/configuration";
import { PrismaService } from "../../prisma/prisma.service";
import { LoggingMetricsService, MetricsService } from "../../observability/metrics.service";
import { ConfirmationPolicyService } from "../confirmation/confirmation-policy.service";
import { CustodyProviderFactory } from "../custody/custody-provider.factory";
import { WithdrawalExecutorFactory } from "../executors/withdrawal-executor.factory";
import { WithdrawalsService } from "../withdrawals/withdrawals.service";

// Same bound as DepositWatcherService's own graceful-shutdown wait — see
// its docblock. There is no persistent lease to expire here as a
// backstop (see this class's own docblock on why one isn't needed), so
// this bound is the only thing standing between a stuck poll and an
// indefinitely-hung shutdown.
const GRACEFUL_SHUTDOWN_MAX_WAIT_MS = 30_000;

export interface WithdrawalWatcherStatus {
  enabled: boolean;
  pollIntervalMs: number;
  lastPollStartedAt: string | null;
  lastPollSuccessAt: string | null;
  lastPollError: string | null;
  lastPollErrorAt: string | null;
  consecutiveFailures: number;
  // Mirrors DepositWatcherService.listCursorStatus's isScanStale
  // reasoning, but computed in-memory (this watcher has no persistent
  // per-item cursor row to read staleness from — see this class's own
  // docblock): stale if enabled but no successful pass has completed
  // recently relative to its own poll interval.
  isStale: boolean;
}

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
 * Phase 14B addition: ALSO polls withdrawals sitting in
 * PENDING_MANUAL_BROADCAST whose configured executor is a REAL,
 * asynchronous provider adapter (one that implements checkStatus()) —
 * this is the automated counterpart to an admin manually calling
 * recordManualBroadcast(), converging on the exact same
 * WithdrawalsService.recordProviderBroadcast()/fail() methods a
 * verified webhook delivery also uses, so there is exactly one place
 * (WithdrawalsService) that ever actually changes a withdrawal's state
 * regardless of which of the three sources (poll, webhook, admin)
 * learned about it first. ManualBroadcastExecutor implements no
 * checkStatus(), so sandbox withdrawals with no real provider configured
 * are entirely unaffected by this addition — an admin's manual broadcast
 * remains the only way those resolve, exactly as before.
 *
 * Off by default (WITHDRAWAL_WATCHER_ENABLED) for the same reason the
 * deposit watcher is: importing this module must never cause an app
 * instance — including every unit and integration test — to start
 * making outbound network calls on its own.
 *
 * Phase 16 — deliberately has NO cross-instance lease, unlike
 * DepositWatcherService's per-assetNetwork CAS lease. That lease exists
 * to protect a single SHARED, ADVANCING CURSOR from being clobbered by
 * a concurrent worker — there is no analogous shared cursor here (this
 * watcher re-lists whatever is currently BROADCAST/CONFIRMING/
 * PENDING_MANUAL_BROADCAST from the database on every pass; there is
 * nothing to "advance" and nothing a second worker could regress).
 * The only shared mutable state two concurrent workers could race on is
 * the Withdrawal row itself, and every mutation method this watcher
 * calls (recordConfirmation/fail/recordProviderBroadcast/
 * failProviderRejectedSubmission, all on WithdrawalsService) guards its
 * update with a status-scoped `updateMany` inside a transaction — a
 * second worker's redundant call always matches zero rows and safely
 * no-ops. Running multiple worker replicas is therefore safe (no
 * duplicate financial effects) without needing new locking machinery;
 * see docs/deployment-architecture.md for the full reasoning.
 */
@Injectable()
export class WithdrawalWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WithdrawalWatcherService.name);
  private timer?: NodeJS.Timeout;
  private polling = false;
  private pollIntervalMs = 30_000;
  private lastPollStartedAt: Date | null = null;
  private lastPollSuccessAt: Date | null = null;
  private lastPollError: string | null = null;
  private lastPollErrorAt: Date | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly custodyProviderFactory: CustodyProviderFactory,
    private readonly confirmationPolicy: ConfirmationPolicyService,
    private readonly withdrawalsService: WithdrawalsService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly executorFactory: WithdrawalExecutorFactory,
    // Same optional-with-a-real-default pattern as DepositWatcherService
    // — see its constructor's own comment.
    private readonly metrics: MetricsService = new LoggingMetricsService(),
  ) {}

  onModuleInit(): void {
    const config = this.configService.get("withdrawalWatcher", { infer: true });
    this.pollIntervalMs = config.pollIntervalMs;
    if (!config.enabled) {
      this.logger.log("Withdrawal confirmation watcher disabled (set WITHDRAWAL_WATCHER_ENABLED=true to start it)");
      return;
    }
    this.logger.log(`Withdrawal confirmation watcher starting — polling every ${config.pollIntervalMs}ms`);
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => this.logger.error("Unhandled error in withdrawal watcher poll", error as Error));
    }, config.pollIntervalMs);
  }

  /** Graceful shutdown — see DepositWatcherService.onModuleDestroy's docblock; identical reasoning, no lease to worry about here (see class docblock). */
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + GRACEFUL_SHUTDOWN_MAX_WAIT_MS;
    while (this.polling && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.polling) {
      this.logger.warn(`Shutting down with a withdrawal poll still in flight after waiting ${GRACEFUL_SHUTDOWN_MAX_WAIT_MS}ms.`);
    }
  }

  /**
   * Operational visibility (Phase 16, mirrors DepositWatcherService.
   * listCursorStatus in spirit) — surfaced via GET /admin/watchers and
   * folded into GET /health/ready. `isStale` uses a 3x-poll-interval
   * grace window (consistent with STALE_CURSOR_THRESHOLD_MS's own
   * "generous relative to normal cadence" reasoning) so one slow pass
   * is never misreported as stuck.
   */
  getStatus(): WithdrawalWatcherStatus {
    const enabled = this.timer !== undefined;
    const staleThresholdMs = this.pollIntervalMs * 3;
    const referenceTime = this.lastPollSuccessAt ?? this.lastPollStartedAt;
    const isStale = enabled && (referenceTime === null || Date.now() - referenceTime.getTime() > staleThresholdMs);
    return {
      enabled,
      pollIntervalMs: this.pollIntervalMs,
      lastPollStartedAt: this.lastPollStartedAt?.toISOString() ?? null,
      lastPollSuccessAt: this.lastPollSuccessAt?.toISOString() ?? null,
      lastPollError: this.lastPollError,
      lastPollErrorAt: this.lastPollErrorAt?.toISOString() ?? null,
      consecutiveFailures: this.consecutiveFailures,
      isStale,
    };
  }

  /**
   * One pass over every withdrawal awaiting on-chain confirmation OR
   * awaiting a real provider's asynchronous broadcast. Each withdrawal's
   * check is caught and logged independently so one broken chain/
   * provider integration or one bad txHash never stalls checking every
   * other withdrawal (same observability reasoning as
   * DepositWatcherService.pollOnce).
   */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.lastPollStartedAt = new Date();
    try {
      const broadcasted = await this.prisma.withdrawal.findMany({
        where: {
          status: { in: [WithdrawalStatus.BROADCAST, WithdrawalStatus.CONFIRMING] },
          txHash: { not: null },
        },
      });
      for (const withdrawal of broadcasted) {
        try {
          await this.checkOne(withdrawal.id, withdrawal.assetNetworkId, withdrawal.txHash!);
        } catch (error) {
          this.logger.error(`Confirmation check failed for withdrawal ${withdrawal.id}`, error as Error);
          this.metrics.increment("wallet.withdrawal_watcher.confirmation_check_failed", { withdrawalId: withdrawal.id });
        }
      }

      const pendingProvider = await this.prisma.withdrawal.findMany({
        where: { status: WithdrawalStatus.PENDING_MANUAL_BROADCAST },
      });
      for (const withdrawal of pendingProvider) {
        try {
          await this.checkPendingProviderSubmission(withdrawal.id, withdrawal.assetNetworkId);
        } catch (error) {
          this.logger.error(`Provider status check failed for withdrawal ${withdrawal.id}`, error as Error);
          this.metrics.increment("wallet.withdrawal_watcher.provider_check_failed", { withdrawalId: withdrawal.id });
        }
      }

      this.lastPollSuccessAt = new Date();
      this.consecutiveFailures = 0;
    } catch (error) {
      // A failure here means the pass itself couldn't even enumerate
      // withdrawals to check (e.g. the database is unreachable) — each
      // individual withdrawal's own check failure is already caught
      // above and never reaches this block.
      this.lastPollError = (error as Error).message;
      this.lastPollErrorAt = new Date();
      this.consecutiveFailures += 1;
      this.metrics.increment("wallet.withdrawal_watcher.poll_failed", { consecutiveFailures: this.consecutiveFailures });
      throw error;
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
      this.metrics.increment("wallet.withdrawal_watcher.marked_failed", { assetNetworkId, reason: "onchain_failed" });
      await this.withdrawalsService.fail(withdrawalId, `Broadcast transaction ${txHash} failed on-chain.`);
      return;
    }

    const requiredConfirmations = await this.confirmationPolicy.getRequiredConfirmations(assetNetworkId);
    await this.withdrawalsService.recordConfirmation(withdrawalId, status.confirmations, requiredConfirmations);
  }

  /**
   * A withdrawal sitting in PENDING_MANUAL_BROADCAST has no txHash yet
   * by definition — there is nothing to check on-chain. Instead, this
   * asks the CONFIGURED EXECUTOR (not the chain) whether it has since
   * learned more, via the optional checkStatus() capability. An
   * executor with no such capability (ManualBroadcastExecutor, or a
   * misconfigured/removed executor) is silently skipped — sandbox
   * withdrawals genuinely awaiting a human keep waiting for one, exactly
   * as before this addition.
   */
  private async checkPendingProviderSubmission(withdrawalId: string, assetNetworkId: string): Promise<void> {
    const executor = await this.executorFactory.resolve(assetNetworkId).catch(() => null);
    if (!executor?.checkStatus) return;

    const lookup = await executor.checkStatus(withdrawalId);

    if (lookup.status === "broadcast" && lookup.txHash) {
      await this.withdrawalsService.recordProviderBroadcast(withdrawalId, lookup.txHash, lookup.providerReference);
      return;
    }
    if (lookup.status === "rejected") {
      this.logger.error(`Withdrawal ${withdrawalId}'s provider submission was rejected (${lookup.reason ?? "no reason given"}) — marking the withdrawal FAILED.`);
      this.metrics.increment("wallet.withdrawal_watcher.marked_failed", { assetNetworkId, reason: "provider_rejected" });
      // Security review finding B1: uses the dedicated, narrower
      // failProviderRejectedSubmission() — never the general-purpose
      // fail() — so a stale/anomalous "rejected" report can never
      // release the reservation of a withdrawal that has already
      // reached BROADCAST/CONFIRMING (a real txHash exists). See that
      // method's own docblock.
      await this.withdrawalsService.failProviderRejectedSubmission(withdrawalId, lookup.reason ?? "Provider reported the submission as rejected.");
      return;
    }
    // "pending" or "not_found": nothing new to record — leave untouched, poll again next pass.
  }
}
