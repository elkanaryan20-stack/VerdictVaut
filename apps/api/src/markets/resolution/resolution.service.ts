import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Market, MarketStatus, OrderStatus, SettlementStatus, UserRole } from "@prisma/client";
import { AuditLogService } from "../../audit/audit-log.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";
import { SettleMarketResult, SettlementService } from "../../settlement/settlement.service";
import { SettlementAttemptFailedException } from "../../settlement/settlement.errors";

/**
 * The explicit market-resolution decision-maker. This is deliberately
 * NOT the same thing as settlement: resolve() decides and durably
 * records the winning outcome (CLOSED -> RESOLVING, a MarketResolution
 * row, and a rate-setting Settlement row per outcome — all in one
 * transaction), then hands off to SettlementService to actually pay out
 * every affected position. RESOLVING is the real, valid, possibly
 * long-lived state of "outcome decided, payouts in flight" — a market
 * only reaches RESOLVED once SettlementService confirms nothing remains
 * unsettled.
 *
 * Authorization is checked here AND independently by RolesGuard at the
 * controller boundary (see MarketsController) — defense in depth, same
 * as RolesGuard's own re-read-from-DB philosophy, so this remains safe
 * even if ever invoked from a future non-HTTP caller.
 */
@Injectable()
export class ResolutionService {
  private readonly logger = new Logger(ResolutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: SerializableTransactionRunner,
    private readonly auditLog: AuditLogService,
    private readonly settlementService: SettlementService,
  ) {}

  /**
   * Decides + records the outcome, then attempts settlement immediately.
   * If settlement fails partway through, the resolution decision itself
   * is NOT rolled back (it already committed) — this throws
   * SettlementAttemptFailedException rather than silently reporting
   * success, and retrySettlement is the safe, idempotent recovery path.
   */
  async resolve(marketId: string, resolverId: string, winningOutcomeId: string, notes?: string): Promise<Market> {
    await this.assertAuthorized(resolverId);

    const { market, previousStatus } = await this.txRunner.run(async (tx) => {
      const current = await tx.market.findUnique({ where: { id: marketId }, include: { outcomes: true } });
      if (!current) {
        throw new NotFoundException("Market not found");
      }

      const winningOutcome = current.outcomes.find((o) => o.id === winningOutcomeId);
      if (!winningOutcome) {
        throw new BadRequestException(`Outcome ${winningOutcomeId} does not belong to market ${marketId}`);
      }

      // Defensive: MarketsService.close() already expires every resting
      // order and releases its reservation before a market can reach
      // CLOSED (the only status this CAS accepts from), so this should
      // be structurally unreachable — but "no economically dangerous
      // state where orders remain matchable after resolution" is worth
      // asserting loudly rather than trusting silently.
      const stillResting = await tx.order.count({
        where: { marketId, status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] } },
      });
      if (stillResting > 0) {
        throw new ConflictException(
          `Market ${marketId} still has ${stillResting} resting order(s) — it must be fully closed before resolution`,
        );
      }

      // The CAS: only a CLOSED market may resolve. This is what rejects
      // resolving twice (a second attempt finds status already RESOLVING
      // or RESOLVED, count === 0) and rejects CANCELLED markets (there is
      // no cancellation path in this phase, but if one existed it would
      // land on CANCELLED, which this CAS also does not accept from).
      const result = await tx.market.updateMany({
        where: { id: marketId, status: MarketStatus.CLOSED },
        data: { status: MarketStatus.RESOLVING },
      });
      if (result.count === 0) {
        throw new ConflictException(
          `Market ${marketId} is in status ${current.status}, expected CLOSED — it may already be resolving/resolved, or was never closed`,
        );
      }

      // marketId is unique on MarketResolution — the actual DB-level
      // "never resolve twice" guarantee, independent of (and a backstop
      // behind) the CAS above.
      await tx.marketResolution.create({
        data: { marketId, winningOutcomeId, resolverId, notes },
      });

      // One Settlement row per outcome — the winner at rate 1, every
      // other outcome at rate 0. Created already-COMPLETED: the rate
      // itself never changes again after this instant.
      await tx.settlement.createMany({
        data: current.outcomes.map((outcome) => ({
          marketId,
          outcomeId: outcome.id,
          payoutPerShare: outcome.id === winningOutcomeId ? "1" : "0",
          status: SettlementStatus.COMPLETED,
          processedAt: new Date(),
        })),
      });

      return {
        market: await tx.market.findUniqueOrThrow({ where: { id: marketId } }),
        previousStatus: current.status,
      };
    });

    await this.auditLog.record({
      actorId: resolverId,
      action: "market.resolve",
      resourceType: "Market",
      resourceId: marketId,
      before: { status: previousStatus },
      after: { status: market.status, winningOutcomeId },
      reason: notes,
    });

    try {
      await this.settlementService.settleMarket(marketId);
    } catch (error) {
      this.logger.error(`Settlement failed after market ${marketId} was resolved`, error as Error);
      throw new SettlementAttemptFailedException(marketId, error);
    }

    return this.prisma.market.findUniqueOrThrow({ where: { id: marketId } });
  }

  /**
   * Explicit, safe-to-repeat recovery path for a market whose
   * settlement pass failed or was left incomplete (SettlementAttemptFailedException,
   * or simply a large market settled in more than one call). A no-op for
   * an already-RESOLVED market. Mirrors OrdersService.retryMatching.
   */
  async retrySettlement(marketId: string, actorId: string): Promise<SettleMarketResult> {
    await this.assertAuthorized(actorId);
    try {
      return await this.settlementService.settleMarket(marketId);
    } catch (error) {
      this.logger.error(`Retried settlement failed for market ${marketId}`, error as Error);
      throw new SettlementAttemptFailedException(marketId, error);
    }
  }

  /**
   * Aggregate, public-safe resolution/settlement status — no individual
   * user's payout amount is exposed here (see PositionSettlementService... /
   * MarketsController's per-user settlement endpoint for that).
   */
  async getResolutionStatus(marketId: string) {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      include: { resolution: { include: { winningOutcome: true } } },
    });
    if (!market) {
      throw new NotFoundException("Market not found");
    }

    const [settledPositions, totalPositions] = await Promise.all([
      this.prisma.position.count({ where: { marketId, settledAt: { not: null } } }),
      this.prisma.position.count({ where: { marketId } }),
    ]);

    return {
      marketId: market.id,
      status: market.status,
      resolution: market.resolution
        ? {
            winningOutcomeId: market.resolution.winningOutcomeId,
            winningOutcomeKey: market.resolution.winningOutcome.key,
            resolverId: market.resolution.resolverId,
            resolvedAt: market.resolution.resolvedAt.toISOString(),
            settledAt: market.resolution.settledAt?.toISOString() ?? null,
            notes: market.resolution.notes,
          }
        : null,
      settlement: { settledPositions, totalPositions },
    };
  }

  private async assertAuthorized(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new ForbiddenException("Unknown user");
    }
    // Market resolution moves real settlement money — reserved to the
    // single platform SUPER_ADMIN authority, not every ADMIN (see the
    // platform-control-model note: deny-by-default for financial/admin
    // operations, no "admin can do everything" guard).
    if (user.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException("Only a SUPER_ADMIN may resolve or settle a market");
    }
  }
}
