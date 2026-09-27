import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { AppConfig } from "../config/configuration";
import { LoggingMetricsService, MetricsService } from "../observability/metrics.service";
import { PrismaService } from "../prisma/prisma.service";
import { CollateralReconciliationService } from "../settlement/collateral-reconciliation.service";
import { IndependentReconciliationService } from "../wallet/reconciliation/independent-reconciliation.service";
import { ScheduledJobStateService } from "./scheduled-job-state.service";

const GRACEFUL_SHUTDOWN_MAX_WAIT_MS = 30_000;

export const INDEPENDENT_RECONCILIATION_JOB_PREFIX = "independent-reconciliation:";
export const COLLATERAL_RECONCILIATION_JOB_KEY = "collateral-reconciliation";

export type ScheduledJobOutcome = "ran" | "skipped" | "failed";

/**
 * Phase 35 — the periodic cadence Phase 33 found missing: runs
 * IndependentReconciliationService.runIndependentRescan for every active
 * asset/network, plus CollateralReconciliationService.checkAllMarkets,
 * from the worker process.
 *
 * Why this is safe to run unattended, on any number of replicas:
 *   - Every job it drives is READ-ONLY with respect to money. Both
 *     services only ever write ReconciliationRun/ReconciliationDiscrepancy
 *     rows and audit entries — they never credit a deposit, settle or
 *     release a withdrawal, touch a reservation, or post a ledger
 *     transaction (see their own docblocks). So a duplicate run could at
 *     worst duplicate RPC work — never money — and even that is prevented:
 *   - Each job is gated by a ScheduledJobState lease (CAS + "not started
 *     within intervalMs"), so across N replicas a given job runs at most
 *     once per interval; a crashed/killed worker's lease is reclaimed
 *     after leaseStaleAfterMs, so a restart never wedges scheduling.
 *   - Discrepancy creation is idempotent per finding identity (fixed
 *     this phase), so repeated runs re-affirm an open finding rather
 *     than stacking duplicates.
 *
 * The cadence (intervalMs) is an OPERATIONAL PARAMETER with a
 * conservative default, not a decided production policy — see
 * AppConfig.reconciliationScheduler. Off by default.
 */
@Injectable()
export class ReconciliationSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationSchedulerService.name);
  private readonly workerId = crypto.randomUUID();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly jobState: ScheduledJobStateService,
    private readonly independentReconciliation: IndependentReconciliationService,
    private readonly collateralReconciliation: CollateralReconciliationService,
    private readonly metrics: MetricsService = new LoggingMetricsService(),
  ) {}

  onModuleInit(): void {
    const config = this.configService.get("reconciliationScheduler", { infer: true });
    if (!config.enabled) {
      this.logger.log("Reconciliation scheduler disabled (set RECONCILIATION_SCHEDULER_ENABLED=true in the worker process to start it)");
      return;
    }
    this.logger.log(
      `Reconciliation scheduler starting — each job at most once per ${config.intervalMs}ms across all replicas (tick ${config.tickIntervalMs}ms, lease reclaim after ${config.leaseStaleAfterMs}ms)`,
    );
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error("Unhandled error in reconciliation scheduler tick", error as Error));
    }, config.tickIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + GRACEFUL_SHUTDOWN_MAX_WAIT_MS;
    while (this.ticking && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.ticking) {
      this.logger.warn("Shutting down with a reconciliation job still in flight — its lease will be reclaimed after leaseStaleAfterMs.");
    }
  }

  /** One pass over every job; each is independently leased, so this is safe to call concurrently from several replicas. Public for tests and ops tooling. */
  async tick(): Promise<Record<string, ScheduledJobOutcome>> {
    if (this.ticking) return {};
    this.ticking = true;
    const outcomes: Record<string, ScheduledJobOutcome> = {};
    try {
      const assetNetworks = await this.prisma.assetNetwork.findMany({
        where: { isActive: true, asset: { isActive: true }, network: { isActive: true } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      for (const { id } of assetNetworks) {
        const jobKey = `${INDEPENDENT_RECONCILIATION_JOB_PREFIX}${id}`;
        outcomes[jobKey] = await this.runJob(jobKey, async () => {
          const { run, discrepancies } = await this.independentReconciliation.runIndependentRescan(id, null);
          return `status=${run.status} findings=${discrepancies.length}`;
        });
      }

      outcomes[COLLATERAL_RECONCILIATION_JOB_KEY] = await this.runJob(COLLATERAL_RECONCILIATION_JOB_KEY, async () => {
        const result = await this.collateralReconciliation.checkAllMarkets(null);
        return `checked=${result.checked} discrepancies=${result.discrepanciesFound} truncated=${result.truncated}`;
      });
    } finally {
      this.ticking = false;
    }
    return outcomes;
  }

  private async runJob(jobKey: string, run: () => Promise<string>): Promise<ScheduledJobOutcome> {
    const config = this.configService.get("reconciliationScheduler", { infer: true });
    const acquired = await this.jobState.tryAcquire(jobKey, {
      workerId: this.workerId,
      minIntervalMs: config.intervalMs,
      staleAfterMs: config.leaseStaleAfterMs,
    });
    if (!acquired) {
      return "skipped";
    }

    const started = Date.now();
    this.metrics.increment("operations.reconciliation_job.started", { jobKey });
    try {
      const summary = await run();
      await this.jobState.release(jobKey, this.workerId, { ok: true, summary });
      this.metrics.increment("operations.reconciliation_job.completed", { jobKey });
      this.metrics.timing("operations.reconciliation_job.duration", Date.now() - started, { jobKey });
      return "ran";
    } catch (error) {
      this.logger.error(`Scheduled reconciliation job ${jobKey} failed`, error as Error);
      await this.jobState.release(jobKey, this.workerId, { ok: false, error: (error as Error).message });
      this.metrics.increment("operations.reconciliation_job.failed", { jobKey });
      return "failed";
    }
  }
}
