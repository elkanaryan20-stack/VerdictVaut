import { Controller, Get, HttpCode, Logger, ServiceUnavailableException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { PrismaService } from "../prisma/prisma.service";
import { DepositWatcherService } from "../wallet/watchers/deposit-watcher.service";
import { WithdrawalWatcherService } from "../wallet/watchers/withdrawal-watcher.service";

/**
 * Phase 13 — this repository had zero health/readiness surface before
 * this phase (see the observability audit: no orchestrator/load-balancer
 * had any way to know if this process's dependencies were alive). No
 * guard, deliberately: an orchestrator probe has no JWT, and a health
 * endpoint exposing no sensitive data doesn't need one.
 *
 * Liveness ("is this process alive") and readiness ("can this instance
 * serve real traffic right now") are deliberately separate endpoints —
 * a transient DB hiccup should not make an orchestrator kill and
 * restart a perfectly healthy process (that's what liveness is for);
 * it should instead stop routing traffic to it until the dependency
 * recovers (that's what readiness is for).
 */
@Controller("health")
@SkipThrottle()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly depositWatcherService: DepositWatcherService,
    private readonly withdrawalWatcherService: WithdrawalWatcherService,
  ) {}

  /** Liveness: the process itself is running. Never checks dependencies. */
  @Get()
  @HttpCode(200)
  liveness() {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  /**
   * Readiness: can this instance actually serve requests right now.
   * Fails closed (503) only when the database itself is unreachable —
   * the one dependency every request needs. Worker/watcher staleness is
   * reported for operational visibility but does NOT fail readiness:
   * a stale blockchain scanner doesn't mean this instance can't serve
   * ordinary API traffic, so a load balancer has no reason to pull it
   * from rotation over that alone (see GET /admin/watchers for the
   * authoritative, SUPER_ADMIN-facing worker health view this
   * summarizes).
   */
  @Get("ready")
  @HttpCode(200)
  async readiness() {
    let databaseOk = true;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      databaseOk = false;
      // Phase 18 remediation — the real error (which can include the
      // literal DB hostname/port, e.g. Prisma's own "Can't reach
      // database server at `host:port`" message) is logged here, INSIDE
      // the process, through the same structured/redacted logger every
      // other error goes through (JsonLoggerService). This endpoint has
      // no guard (see this class's own docblock — an orchestrator probe
      // carries no JWT), so anything placed in the HTTP response itself
      // is effectively public; the caller gets only a generic status,
      // never infrastructure detail.
      this.logger.error("Readiness check: database unreachable", (error as Error).stack ?? String(error));
    }

    if (!databaseOk) {
      throw new ServiceUnavailableException({
        status: "not_ready",
        checks: { database: { ok: false, error: "unavailable" } },
      });
    }

    const cursors = await this.depositWatcherService.listCursorStatus().catch(() => []);
    const staleWatchers = cursors.filter((c) => c.isScanStale).map((c) => ({ assetSymbol: c.assetSymbol, networkCode: c.networkCode }));

    // Same "never fail readiness over a status LOOKUP itself throwing"
    // reasoning as the deposit-watcher cursor list above — getStatus()
    // is a synchronous in-memory read and should never throw in
    // practice, but the same defensive shape is kept for consistency.
    const withdrawalWatcherStatus = (() => {
      try {
        return this.withdrawalWatcherService.getStatus();
      } catch {
        return null;
      }
    })();

    return {
      status: "ok",
      checks: {
        database: { ok: true },
        blockchainWatchers: {
          ok: staleWatchers.length === 0,
          staleCount: staleWatchers.length,
          stale: staleWatchers,
        },
        withdrawalWatcher: withdrawalWatcherStatus
          ? {
              ok: !withdrawalWatcherStatus.isStale,
              enabled: withdrawalWatcherStatus.enabled,
              isStale: withdrawalWatcherStatus.isStale,
              consecutiveFailures: withdrawalWatcherStatus.consecutiveFailures,
            }
          : { ok: true, enabled: false, isStale: false, consecutiveFailures: 0 },
      },
    };
  }
}
