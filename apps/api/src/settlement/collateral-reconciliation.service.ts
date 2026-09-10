import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma, ReconciliationStatus } from "@prisma/client";
import { AuditLogService } from "../audit/audit-log.service";
import { LoggingMetricsService, MetricsService } from "../observability/metrics.service";
import { isUniqueConstraintViolation } from "../prisma/idempotent-create.util";
import { PrismaService } from "../prisma/prisma.service";
import { DiscrepancySeverity } from "../wallet/reconciliation/independent-reconciliation.service";

// 1 base unit at 18 decimals — rounding slack, not a real discrepancy
// allowance. Matches IndependentReconciliationService's own tolerance.
const RECONCILIATION_TOLERANCE = new Prisma.Decimal("0.000000000000000001");

// Bounded, same reasoning as the rest of this codebase's reconciliation
// passes (Part 24: "avoid unbounded scans") — a platform-wide sweep
// checks at most this many markets per call; run it again to cover more.
const MAX_MARKETS_PER_CHECK_ALL = 200;

/**
 * Phase 13 — closes the gap the Phase 12A audit exposed: nothing had
 * ever independently verified that a market's own collateral
 * LedgerAccount balance actually equals the total collateral it should
 * hold. By construction (see CompleteSetMint's
 * complete_set_mints_price_sum_check and ExecutionCoordinator's
 * postMintLedger), that balance should always equal:
 *
 *   totalMinted(market) - totalPaidOut(market)
 *
 * where totalMinted is the sum of every CompleteSetMint.quantity for the
 * market (each unit of quantity locks exactly 1 unit of collateral) and
 * totalPaidOut is the sum of every PositionSettlement.payoutAmount for
 * the market (SettlementService debits the market's own collateral
 * account for every payout — see settlement.service.ts). This service
 * independently recomputes both sides from first-class ledger rows and
 * compares them against the live LedgerAccount.cachedBalance.
 *
 * Same safety posture as IndependentReconciliationService: NEVER
 * auto-mutates a balance/mint/settlement — every finding is a
 * first-class ReconciliationDiscrepancy row (this phase extended that
 * table and ReconciliationRun to be market-scoped as an alternative to
 * asset-network-scoped — see the schema's "exactly one of
 * assetNetworkId/marketId" CHECK constraints) for a SUPER_ADMIN to
 * acknowledge/resolve explicitly.
 */
@Injectable()
export class CollateralReconciliationService {
  private readonly logger = new Logger(CollateralReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly metrics: MetricsService = new LoggingMetricsService(),
  ) {}

  async checkMarket(marketId: string, initiatedByUserId: string) {
    const market = await this.prisma.market.findUnique({ where: { id: marketId } });
    if (!market) {
      throw new NotFoundException("Market not found");
    }

    const settlementAsset = await this.prisma.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } });

    const [mintAgg, payoutAgg, account] = await Promise.all([
      this.prisma.completeSetMint.aggregate({ where: { marketId }, _sum: { quantity: true } }),
      this.prisma.positionSettlement.aggregate({ where: { marketId }, _sum: { payoutAmount: true } }),
      this.prisma.ledgerAccount.findUnique({
        where: { marketId_assetId: { marketId, assetId: settlementAsset.id } },
      }),
    ]);

    const totalMinted = mintAgg._sum.quantity ?? new Prisma.Decimal(0);
    const totalPaidOut = payoutAgg._sum.payoutAmount ?? new Prisma.Decimal(0);
    const expectedBalance = totalMinted.minus(totalPaidOut);
    const actualBalance = account?.cachedBalance ?? new Prisma.Decimal(0);
    const difference = actualBalance.minus(expectedBalance);
    const hasMismatch = difference.abs().greaterThan(RECONCILIATION_TOLERANCE);

    const run = await this.prisma.reconciliationRun.create({
      data: {
        marketId,
        status: hasMismatch ? ReconciliationStatus.DISCREPANCY_FOUND : ReconciliationStatus.OK,
        runType: "COLLATERAL_CHECK",
        initiatedByUserId,
        notes: hasMismatch ? "1 finding(s) from collateral check." : "Collateral matches expected balance.",
      },
    });

    let discrepancy = null;
    if (hasMismatch) {
      // A shortfall (actual < expected) means the market cannot fully
      // pay every winning position — CRITICAL. A surplus (actual >
      // expected) means collateral exists that no mint/payout accounts
      // for — anomalous, worth investigating, but not a "can't pay
      // winners" failure — WARNING.
      const severity: DiscrepancySeverity = difference.isNegative() ? "CRITICAL" : "WARNING";
      this.metrics.increment("settlement.collateral_reconciliation.discrepancy_found", { severity, marketId });
      discrepancy = await this.createDiscrepancy(run.id, marketId, {
        severity,
        expectedBalance,
        actualBalance,
        totalMinted,
        totalPaidOut,
      });
    }

    await this.auditLog.record({
      actorId: initiatedByUserId,
      action: "reconciliation.collateral_check_completed",
      resourceType: "Market",
      resourceId: marketId,
      after: { status: run.status, expectedBalance: expectedBalance.toString(), actualBalance: actualBalance.toString() },
    });

    return { run, discrepancy };
  }

  /** Bounded platform-wide sweep over every market that has ever minted collateral. */
  async checkAllMarkets(initiatedByUserId: string) {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { ownerType: "MARKET", marketId: { not: null } },
      select: { marketId: true },
      distinct: ["marketId"],
      take: MAX_MARKETS_PER_CHECK_ALL,
    });

    const results = [];
    for (const { marketId } of accounts) {
      if (!marketId) continue;
      try {
        results.push({ marketId, ...(await this.checkMarket(marketId, initiatedByUserId)) });
      } catch (error) {
        this.logger.error(`Collateral check failed for market ${marketId}`, error as Error);
        results.push({ marketId, error: (error as Error).message });
      }
    }

    return {
      checked: results.length,
      truncated: accounts.length === MAX_MARKETS_PER_CHECK_ALL,
      discrepanciesFound: results.filter((r) => "discrepancy" in r && r.discrepancy).length,
      results,
    };
  }

  async listRuns(marketId: string) {
    return this.prisma.reconciliationRun.findMany({
      where: { marketId, runType: "COLLATERAL_CHECK" },
      orderBy: { runAt: "desc" },
      take: 50,
      include: { discrepancyRecords: true },
    });
  }

  /**
   * Same idempotency shape as IndependentReconciliationService's own
   * createDiscrepancy: a still-OPEN/ACKNOWLEDGED prior finding for this
   * market is returned as-is (re-running the check doesn't spam
   * duplicate rows); a genuinely new occurrence after the prior one was
   * RESOLVED/FALSE_POSITIVE gets its own row.
   */
  private async createDiscrepancy(
    runId: string,
    marketId: string,
    input: {
      severity: DiscrepancySeverity;
      expectedBalance: Prisma.Decimal;
      actualBalance: Prisma.Decimal;
      totalMinted: Prisma.Decimal;
      totalPaidOut: Prisma.Decimal;
    },
  ) {
    const baseKey = `market:${marketId}:collateral_balance_mismatch`;
    const existing = await this.prisma.reconciliationDiscrepancy.findUnique({ where: { idempotencyKey: baseKey } });
    if (existing && (existing.status === "OPEN" || existing.status === "ACKNOWLEDGED")) {
      return existing;
    }

    const idempotencyKey = existing ? `${baseKey}:${Date.now()}` : baseKey;
    try {
      return await this.prisma.reconciliationDiscrepancy.create({
        data: {
          runId,
          marketId,
          type: "collateral_balance_mismatch",
          severity: input.severity,
          chainIdentity: `collateral:${marketId}`,
          internalEntityType: "Market",
          internalEntityId: marketId,
          expectedState: {
            expectedBalance: input.expectedBalance.toString(),
            totalMinted: input.totalMinted.toString(),
            totalPaidOut: input.totalPaidOut.toString(),
          } as Prisma.InputJsonValue,
          observedState: { actualBalance: input.actualBalance.toString() } as Prisma.InputJsonValue,
          idempotencyKey,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error, "idempotencyKey")) throw error;
      return this.prisma.reconciliationDiscrepancy.findUniqueOrThrow({ where: { idempotencyKey } });
    }
  }
}
