import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DiscrepancyStatus, Prisma, ReconciliationStatus, WithdrawalStatus } from "@prisma/client";
import { AuditLogService } from "../../audit/audit-log.service";
import { LoggingMetricsService, MetricsService } from "../../observability/metrics.service";
import { isUniqueConstraintViolation } from "../../prisma/idempotent-create.util";
import { PrismaService } from "../../prisma/prisma.service";
import { CustodyProviderFactory } from "../custody/custody-provider.factory";
import { DepositChainAdapterFactory } from "../chain-adapters/deposit-chain-adapter.factory";
import { RawChainDeposit } from "../chain-adapters/deposit-chain-adapter.interface";
import { loadWatchedAddresses } from "../chain-adapters/watched-addresses.util";

const RECONCILIATION_TOLERANCE = new Prisma.Decimal("0.000000000000000001"); // 1 base unit at 18 decimals — rounding slack, not a real discrepancy allowance

// Bounded, same reasoning as ReconciliationService's own
// LEDGER_CONSISTENCY_CHECK_LIMIT — recent activity, not a full-history
// scan (Part 24: "avoid unbounded discrepancy loading").
const RECENT_DEPOSITS_CHECK_LIMIT = 50;
const RECENT_WITHDRAWALS_CHECK_LIMIT = 50;

const IN_FLIGHT_WITHDRAWAL_STATUSES: WithdrawalStatus[] = [
  WithdrawalStatus.BROADCAST,
  WithdrawalStatus.CONFIRMING,
  WithdrawalStatus.CONFIRMED,
  WithdrawalStatus.CREDITED,
];

export type DiscrepancySeverity = "INFO" | "WARNING" | "CRITICAL";

export interface IndependentDiscrepancyInput {
  type: string;
  severity: DiscrepancySeverity;
  /** The independent evidence key that proves this discrepancy's identity — e.g. "txHash:eventIndex" or a bare txHash. */
  chainIdentity: string;
  internalEntityType?: string;
  internalEntityId?: string;
  expectedState: Record<string, unknown>;
  observedState: Record<string, unknown>;
}

/**
 * Phase 12A — independent of ReconciliationService (the original,
 * cursor-adjacent checks: address-balance vs. internal-ledger
 * consistency, stale-cursor detection). This service NEVER reads
 * BlockchainWatchCursor.lastScannedPointer — its entire resume-point
 * input is either an explicit SUPER_ADMIN-supplied `fromPointer` or
 * `null` (each chain adapter's own bounded "first scan" default
 * backfill — INITIAL_BACKFILL_BLOCKS for EVM, one page for
 * Bitcoin/Solana/XRP), so a bug or manipulation of the persisted watcher
 * cursor can never hide a real discrepancy from this check.
 *
 * Deliberately reuses the same BlockchainDepositAdapter.scanForDeposits
 * every normal watcher poll calls (Part 14: never normalize away
 * chain-specific evidence) rather than a second, parallel chain-reading
 * implementation — this both avoids duplicating four chains' worth of
 * RPC logic and means "one independent rescan call" is bounded by the
 * exact same per-call range caps (LOG_SCAN_MAX_BLOCK_RANGE,
 * NATIVE_SCAN_MAX_BLOCK_RANGE, page-size limits) the normal watcher
 * already relies on — an arbitrarily-old `fromPointer` can never trigger
 * an unbounded rescan; it just means the returned `toPointer` covers
 * less of the requested range in this one call, exactly like a single
 * watcher poll (Part 10/24).
 *
 * NEVER auto-mutates a balance/deposit/withdrawal (Part 13) — every
 * finding becomes a first-class ReconciliationDiscrepancy row for a
 * SUPER_ADMIN to acknowledge/resolve explicitly.
 */
@Injectable()
export class IndependentReconciliationService {
  private readonly logger = new Logger(IndependentReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapterFactory: DepositChainAdapterFactory,
    private readonly custodyProviderFactory: CustodyProviderFactory,
    private readonly auditLog: AuditLogService,
    private readonly metrics: MetricsService = new LoggingMetricsService(),
  ) {}

  async runIndependentRescan(assetNetworkId: string, initiatedByUserId: string, fromPointer?: string) {
    const assetNetwork = await this.prisma.assetNetwork.findUnique({ where: { id: assetNetworkId } });
    if (!assetNetwork) {
      throw new NotFoundException("Asset/network pair not found");
    }

    await this.auditLog.record({
      actorId: initiatedByUserId,
      action: "reconciliation.independent_rescan_started",
      resourceType: "AssetNetwork",
      resourceId: assetNetworkId,
      after: { fromPointer: fromPointer ?? null },
    });

    const findings: IndependentDiscrepancyInput[] = [];
    let toPointer: string | null = null;
    let providerErrored = false;

    try {
      const { adapter, network } = await this.adapterFactory.resolve(assetNetworkId);
      const addresses = await loadWatchedAddresses(this.prisma, assetNetworkId);

      if (addresses.length > 0) {
        const { deposits: observed, nextCursor } = await adapter.scanForDeposits({
          network,
          addresses,
          cursor: fromPointer ?? null,
        });
        toPointer = nextCursor;

        findings.push(...(await this.compareObservedDeposits(assetNetworkId, observed)));
        findings.push(...(await this.checkRecentCreditedDepositsHaveChainEvidence(assetNetworkId, observed)));
      }

      findings.push(...(await this.checkRecentWithdrawals(assetNetworkId)));
    } catch (error) {
      providerErrored = true;
      this.logger.error(`Independent reconciliation rescan failed for assetNetwork ${assetNetworkId}`, error as Error);
      findings.push({
        type: "rescan_provider_error",
        severity: "WARNING",
        chainIdentity: assetNetworkId,
        expectedState: {},
        observedState: { error: (error as Error).message },
      });
    }

    const status = providerErrored
      ? ReconciliationStatus.ERROR
      : findings.length > 0
        ? ReconciliationStatus.DISCREPANCY_FOUND
        : ReconciliationStatus.OK;

    const run = await this.prisma.reconciliationRun.create({
      data: {
        assetNetworkId,
        status,
        runType: "INDEPENDENT_RESCAN",
        initiatedByUserId,
        fromPointer: fromPointer ?? null,
        toPointer,
        notes: `${findings.length} finding(s) from independent rescan.`,
      },
    });

    const discrepancies = [];
    for (const finding of findings) {
      discrepancies.push(await this.createDiscrepancy(run.id, assetNetworkId, finding));
    }

    await this.auditLog.record({
      actorId: initiatedByUserId,
      action: "reconciliation.independent_rescan_completed",
      resourceType: "AssetNetwork",
      resourceId: assetNetworkId,
      after: { status, findingCount: findings.length },
    });

    return { run, discrepancies };
  }

  /**
   * Forward direction (Part 11 #1/#3): every independently-observed
   * chain event either has a matching internal Deposit record with a
   * matching amount, or it doesn't — no false-positive risk here (unlike
   * the reverse check below), since an observed event is unambiguous
   * evidence regardless of window size.
   */
  private async compareObservedDeposits(assetNetworkId: string, observed: RawChainDeposit[]): Promise<IndependentDiscrepancyInput[]> {
    const findings: IndependentDiscrepancyInput[] = [];

    for (const raw of observed) {
      const internal = await this.prisma.deposit.findUnique({
        where: { assetNetworkId_txHash_eventIndex: { assetNetworkId, txHash: raw.txHash, eventIndex: raw.eventIndex } },
      });
      const chainIdentity = `${raw.txHash}:${raw.eventIndex}`;

      if (!internal) {
        findings.push({
          type: "chain_event_missing_internal_deposit",
          severity: "CRITICAL",
          chainIdentity,
          expectedState: { internalDepositExists: true },
          observedState: { txHash: raw.txHash, eventIndex: raw.eventIndex, amount: raw.amount, walletAddressId: raw.walletAddressId },
        });
        continue;
      }

      const difference = new Prisma.Decimal(raw.amount).minus(internal.amount).abs();
      if (difference.greaterThan(RECONCILIATION_TOLERANCE)) {
        findings.push({
          type: "deposit_amount_mismatch",
          severity: "CRITICAL",
          chainIdentity,
          internalEntityType: "Deposit",
          internalEntityId: internal.id,
          expectedState: { amount: internal.amount.toString() },
          observedState: { amount: raw.amount },
        });
      }
    }

    return findings;
  }

  /**
   * Reverse direction (Part 11 #2): a recently-CREDITED internal deposit
   * this rescan did NOT independently re-observe. CAVEAT, documented
   * honestly rather than hidden: a deposit older than this call's
   * bounded window is expected to be absent from `observed` without
   * anything actually being wrong — this check cannot distinguish that
   * from genuine missing chain evidence. Treat a finding here as
   * "investigate" (check a block explorer, or re-run with an explicit
   * wider `fromPointer`), not as certain proof of a problem — exactly
   * why this is a discrepancy record for a human to acknowledge/resolve,
   * never an automatic action.
   */
  private async checkRecentCreditedDepositsHaveChainEvidence(
    assetNetworkId: string,
    observed: RawChainDeposit[],
  ): Promise<IndependentDiscrepancyInput[]> {
    const observedKeys = new Set(observed.map((o) => `${o.txHash}:${o.eventIndex}`));
    const recentCredited = await this.prisma.deposit.findMany({
      where: { assetNetworkId, status: "CREDITED" },
      orderBy: { creditedAt: "desc" },
      take: RECENT_DEPOSITS_CHECK_LIMIT,
    });

    const findings: IndependentDiscrepancyInput[] = [];
    for (const deposit of recentCredited) {
      const chainIdentity = `${deposit.txHash}:${deposit.eventIndex}`;
      if (observedKeys.has(chainIdentity)) continue;

      findings.push({
        type: "internal_deposit_missing_chain_evidence",
        severity: "CRITICAL",
        chainIdentity,
        internalEntityType: "Deposit",
        internalEntityId: deposit.id,
        expectedState: { onChainTxExists: true, amount: deposit.amount.toString() },
        observedState: {
          note: "Not found within this rescan's window — may be legitimately older than the window scanned; widen fromPointer before escalating as fraud.",
        },
      });
    }
    return findings;
  }

  /**
   * Part 11 #9/#10: an in-flight (BROADCAST or later) withdrawal whose
   * txHash the chain no longer recognizes at all, or whose independently
   * re-checked status contradicts what we believe internally. Reuses
   * CustodyProvider.getTransactionStatus — the exact same primitive
   * WithdrawalsService.reconcile() uses for a single withdrawal — as a
   * batched, discrepancy-record-producing pass over recent activity
   * rather than a per-withdrawal admin action.
   */
  private async checkRecentWithdrawals(assetNetworkId: string): Promise<IndependentDiscrepancyInput[]> {
    const withdrawals = await this.prisma.withdrawal.findMany({
      where: { assetNetworkId, status: { in: IN_FLIGHT_WITHDRAWAL_STATUSES }, txHash: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: RECENT_WITHDRAWALS_CHECK_LIMIT,
    });
    if (withdrawals.length === 0) return [];

    const provider = await this.custodyProviderFactory.resolve(assetNetworkId);
    const findings: IndependentDiscrepancyInput[] = [];

    for (const withdrawal of withdrawals) {
      try {
        const chainStatus = await provider.getTransactionStatus(withdrawal.txHash!, assetNetworkId);

        if (chainStatus.status === "not_found") {
          findings.push({
            type: "withdrawal_tx_missing",
            severity: "CRITICAL",
            chainIdentity: withdrawal.txHash!,
            internalEntityType: "Withdrawal",
            internalEntityId: withdrawal.id,
            expectedState: { internalStatus: withdrawal.status },
            observedState: { chainStatus: chainStatus.status },
          });
        } else if (chainStatus.status === "failed" && (withdrawal.status === "CONFIRMED" || withdrawal.status === "CREDITED")) {
          findings.push({
            type: "withdrawal_status_chain_mismatch",
            severity: "CRITICAL",
            chainIdentity: withdrawal.txHash!,
            internalEntityType: "Withdrawal",
            internalEntityId: withdrawal.id,
            expectedState: { internalStatus: withdrawal.status },
            observedState: { chainStatus: chainStatus.status },
          });
        }
      } catch (error) {
        findings.push({
          type: "withdrawal_chain_lookup_failed",
          severity: "WARNING",
          chainIdentity: withdrawal.txHash!,
          internalEntityType: "Withdrawal",
          internalEntityId: withdrawal.id,
          expectedState: {},
          observedState: { error: (error as Error).message },
        });
      }
    }
    return findings;
  }

  /**
   * Deterministic idempotencyKey = assetNetworkId + type + chainIdentity
   * — re-running a rescan that re-observes the SAME still-OPEN/
   * ACKNOWLEDGED real-world discrepancy returns the existing row rather
   * than creating a duplicate. A genuinely NEW occurrence of the same
   * (type, chainIdentity) pair AFTER the prior one was RESOLVED/
   * FALSE_POSITIVE gets its own row (never silently suppressed by
   * history) via a uniquified key.
   */
  private async createDiscrepancy(runId: string, assetNetworkId: string, input: IndependentDiscrepancyInput) {
    // Fired on every finding attempt, not just newly-created rows — an
    // ops alert on a REPEATED still-open CRITICAL discrepancy is exactly
    // as important as the first occurrence, since nothing here ever
    // auto-resolves one.
    this.metrics.increment("wallet.reconciliation.discrepancy_found", { severity: input.severity, type: input.type });

    const baseKey = `${assetNetworkId}:${input.type}:${input.chainIdentity}`;
    const existing = await this.prisma.reconciliationDiscrepancy.findUnique({ where: { idempotencyKey: baseKey } });
    if (existing && (existing.status === "OPEN" || existing.status === "ACKNOWLEDGED")) {
      return existing;
    }

    const idempotencyKey = existing ? `${baseKey}:${Date.now()}` : baseKey;
    try {
      return await this.prisma.reconciliationDiscrepancy.create({
        data: {
          runId,
          assetNetworkId,
          type: input.type,
          severity: input.severity,
          chainIdentity: input.chainIdentity,
          internalEntityType: input.internalEntityType,
          internalEntityId: input.internalEntityId,
          expectedState: input.expectedState as Prisma.InputJsonValue,
          observedState: input.observedState as Prisma.InputJsonValue,
          idempotencyKey,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintViolation(error, "idempotencyKey")) throw error;
      return this.prisma.reconciliationDiscrepancy.findUniqueOrThrow({ where: { idempotencyKey } });
    }
  }

  async listDiscrepancies(filters: { assetNetworkId?: string; marketId?: string; status?: DiscrepancyStatus } = {}) {
    return this.prisma.reconciliationDiscrepancy.findMany({
      where: { assetNetworkId: filters.assetNetworkId, marketId: filters.marketId, status: filters.status },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  async listRuns(assetNetworkId: string) {
    return this.prisma.reconciliationRun.findMany({
      where: { assetNetworkId, runType: "INDEPENDENT_RESCAN" },
      orderBy: { runAt: "desc" },
      take: 50,
      include: { discrepancyRecords: true },
    });
  }

  /** SUPER_ADMIN acknowledges a discrepancy is seen/being investigated — does not close it. */
  async acknowledge(discrepancyId: string, actorId: string): Promise<boolean> {
    const result = await this.prisma.reconciliationDiscrepancy.updateMany({
      where: { id: discrepancyId, status: "OPEN" },
      data: { status: "ACKNOWLEDGED" },
    });
    if (result.count > 0) {
      await this.auditLog.record({
        actorId,
        action: "reconciliation.discrepancy_acknowledged",
        resourceType: "ReconciliationDiscrepancy",
        resourceId: discrepancyId,
      });
    }
    return result.count > 0;
  }

  /**
   * SUPER_ADMIN closes a discrepancy with a required note, as RESOLVED
   * (a real, separately-executed correction happened elsewhere — e.g. a
   * manual ledger adjustment, or the deposit was reprocessed) or
   * FALSE_POSITIVE (investigation showed nothing was actually wrong,
   * e.g. it was outside the rescanned window). This method itself NEVER
   * mutates a balance/deposit/withdrawal — it only records that a human
   * closed the finding, per Part 13.
   */
  async resolve(discrepancyId: string, actorId: string, notes: string, outcome: "RESOLVED" | "FALSE_POSITIVE" = "RESOLVED"): Promise<boolean> {
    const result = await this.prisma.reconciliationDiscrepancy.updateMany({
      where: { id: discrepancyId, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      data: { status: outcome, resolvedByUserId: actorId, resolvedAt: new Date(), notes },
    });
    if (result.count > 0) {
      await this.auditLog.record({
        actorId,
        action: outcome === "RESOLVED" ? "reconciliation.discrepancy_resolved" : "reconciliation.discrepancy_marked_false_positive",
        resourceType: "ReconciliationDiscrepancy",
        resourceId: discrepancyId,
        reason: notes,
      });
    }
    return result.count > 0;
  }
}
