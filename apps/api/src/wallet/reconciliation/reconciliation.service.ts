import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DepositStatus, Prisma, ReconciliationStatus, WalletAddressStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { CustodyProviderFactory } from "../custody/custody-provider.factory";

export type ReconciliationSeverity = "INFO" | "WARNING" | "CRITICAL";

/**
 * One deterministic finding — never a vague blob. `type` is a stable,
 * machine-matchable slug (see the SEVERITY_BY_TYPE table below, which is
 * the single place severity is decided, so classification stays
 * consistent across every check this service runs — requirement #14).
 * Nothing here ever mutates a balance/deposit/withdrawal to "fix"
 * itself — see this service's own class docblock.
 */
export interface ReconciliationDiscrepancy {
  type:
    | "address_balance_mismatch"
    | "credited_deposit_missing_ledger_transaction"
    | "ledger_transaction_missing_credited_deposit"
    | "stale_watcher_cursor"
    | "address_lookup_failed";
  severity: ReconciliationSeverity;
  message: string;
  details: Record<string, unknown>;
}

const RECONCILIATION_TOLERANCE = new Prisma.Decimal("0.000000000000000001"); // 1 base unit at 18 decimals — pure floating/rounding slack, not a real discrepancy allowance

// Bounded rather than an unbounded historical scan (requirement #22:
// "avoid unbounded queries") — reconciliation is a periodic, admin-
// triggered spot-check, not a full-history audit tool; the most recent
// activity is both the likeliest to still be actionable and the
// cheapest to re-check on every run. A deeper historical audit is an
// explicit, separate, documented-as-not-implemented capability (see
// requirement #26.15's own report).
const LEDGER_CONSISTENCY_CHECK_LIMIT = 500;

// A cursor is "stale" once it's gone this long without a successful
// scan — long enough that a normal poll interval (default 30s) missing
// a few cycles isn't a false alarm, short enough to be a genuinely
// actionable operational signal (requirement #15: stale workers).
// Exported so DepositWatcherService.listCursorStatus (admin operational
// visibility) classifies staleness with the exact same threshold this
// service's own reconciliation check uses — never two different answers
// to "is this cursor stale" in two different places.
export const STALE_CURSOR_THRESHOLD_MS = 15 * 60_000;

const SEVERITY_BY_TYPE: Record<ReconciliationDiscrepancy["type"], ReconciliationSeverity> = {
  address_balance_mismatch: "CRITICAL",
  credited_deposit_missing_ledger_transaction: "CRITICAL",
  ledger_transaction_missing_credited_deposit: "CRITICAL",
  stale_watcher_cursor: "WARNING",
  address_lookup_failed: "WARNING",
};

function discrepancy(type: ReconciliationDiscrepancy["type"], message: string, details: Record<string, unknown> = {}): ReconciliationDiscrepancy {
  return { type, severity: SEVERITY_BY_TYPE[type], message, details };
}

/**
 * Compares this platform's own records against independent, authoritative
 * evidence for one asset/network at a time — real on-chain balances (via
 * CustodyProvider, never a cached figure) AND this platform's own
 * ledger/deposit consistency. Deliberately a narrow, honest set of checks
 * (see each one's own comment for exactly what it does and does not
 * cover) — NEVER auto-mutates a balance, deposit, or withdrawal to "fix"
 * anything found; every discrepancy is recorded for a SUPER_ADMIN to act
 * on explicitly (requirement #13).
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerFactory: CustodyProviderFactory,
  ) {}

  async run(assetNetworkId: string) {
    const assetNetwork = await this.prisma.assetNetwork.findUnique({ where: { id: assetNetworkId } });
    if (!assetNetwork) {
      throw new NotFoundException("Asset/network pair not found");
    }

    const findings: ReconciliationDiscrepancy[] = [];
    let lookupErrorCount = 0;

    const { discrepancies: addressDiscrepancies, errorCount } = await this.checkAddressBalances(assetNetworkId);
    findings.push(...addressDiscrepancies);
    lookupErrorCount += errorCount;

    findings.push(...(await this.checkLedgerDepositConsistency(assetNetworkId, assetNetwork.assetId)));
    findings.push(...(await this.checkStaleCursor(assetNetworkId)));

    const status = lookupErrorCount > 0 ? ReconciliationStatus.ERROR : findings.length > 0 ? ReconciliationStatus.DISCREPANCY_FOUND : ReconciliationStatus.OK;

    const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
    const warningCount = findings.filter((f) => f.severity === "WARNING").length;

    return this.prisma.reconciliationRun.create({
      data: {
        assetNetworkId,
        status,
        discrepancies: { findings, criticalCount, warningCount } as unknown as Prisma.InputJsonValue,
        notes: `${findings.length} finding(s): ${criticalCount} critical, ${warningCount} warning.`,
      },
    });
  }

  /**
   * Address-level: real on-chain balance vs. the sum of CREDITED Deposit
   * rows for that specific address (NOT LedgerAccount.cachedBalance,
   * which is a per-user total across every address/asset and would
   * defeat the point of an address-level check).
   */
  private async checkAddressBalances(assetNetworkId: string): Promise<{ discrepancies: ReconciliationDiscrepancy[]; errorCount: number }> {
    const addresses = await this.prisma.walletAddress.findMany({ where: { assetNetworkId, status: WalletAddressStatus.ASSIGNED } });
    if (addresses.length === 0) return { discrepancies: [], errorCount: 0 };

    const provider = await this.providerFactory.resolve(assetNetworkId);
    const discrepancies: ReconciliationDiscrepancy[] = [];
    let errorCount = 0;

    for (const address of addresses) {
      try {
        const [chainBalance, internalTotal] = await Promise.all([
          provider.getAddressBalance(address.address, assetNetworkId),
          this.sumCreditedDeposits(address.id),
        ]);

        const difference = new Prisma.Decimal(chainBalance.balance).minus(internalTotal).abs();
        if (difference.greaterThan(RECONCILIATION_TOLERANCE)) {
          discrepancies.push(
            discrepancy("address_balance_mismatch", `On-chain balance for ${address.address} does not match the internal credited total.`, {
              walletAddressId: address.id,
              address: address.address,
              chainBalance: chainBalance.balance,
              internalCreditedTotal: internalTotal.toString(),
              difference: difference.toString(),
            }),
          );
        }
      } catch (error) {
        this.logger.error(`Reconciliation chain lookup failed for address ${address.address}`, error as Error);
        errorCount += 1;
        discrepancies.push(
          discrepancy("address_lookup_failed", `Could not look up the on-chain balance for ${address.address}.`, {
            walletAddressId: address.id,
            address: address.address,
            error: (error as Error).message,
          }),
        );
      }
    }

    return { discrepancies, errorCount };
  }

  /**
   * Cross-checks this platform's own two records of "a deposit was
   * credited" against each other, in BOTH directions:
   *  - a CREDITED deposit whose soft ledgerTransactionId reference
   *    doesn't actually resolve to a real LedgerTransaction (the credit
   *    path is supposed to set both atomically in the same transaction —
   *    see DepositsService.creditDeposit — so this should never happen
   *    absent a genuine bug or manual DB tampering);
   *  - a LedgerTransaction posted for this asset's DEPOSIT type whose
   *    referenced Deposit is not itself CREDITED (the reverse gap: a
   *    ledger credit exists but the deposit record disagrees).
   * Bounded (LEDGER_CONSISTENCY_CHECK_LIMIT) and ordered most-recent-first
   * — see that constant's own comment.
   */
  private async checkLedgerDepositConsistency(assetNetworkId: string, assetId: string): Promise<ReconciliationDiscrepancy[]> {
    const findings: ReconciliationDiscrepancy[] = [];

    const creditedDeposits = await this.prisma.deposit.findMany({
      where: { assetNetworkId, status: DepositStatus.CREDITED },
      orderBy: { creditedAt: "desc" },
      take: LEDGER_CONSISTENCY_CHECK_LIMIT,
      select: { id: true, ledgerTransactionId: true, amount: true },
    });

    const referencedTxIds = creditedDeposits.map((d) => d.ledgerTransactionId).filter((id): id is string => id != null);
    const existingTxIds = new Set(
      (await this.prisma.ledgerTransaction.findMany({ where: { id: { in: referencedTxIds } }, select: { id: true } })).map((t) => t.id),
    );

    for (const deposit of creditedDeposits) {
      if (!deposit.ledgerTransactionId || !existingTxIds.has(deposit.ledgerTransactionId)) {
        findings.push(
          discrepancy("credited_deposit_missing_ledger_transaction", `Deposit ${deposit.id} is CREDITED but has no corresponding ledger transaction.`, {
            depositId: deposit.id,
            amount: deposit.amount.toString(),
          }),
        );
      }
    }

    const depositLedgerTxns = await this.prisma.ledgerTransaction.findMany({
      where: { assetId, type: "DEPOSIT", referenceType: "Deposit" },
      orderBy: { createdAt: "desc" },
      take: LEDGER_CONSISTENCY_CHECK_LIMIT,
      select: { id: true, referenceId: true },
    });

    const referencedDepositIds = depositLedgerTxns.map((t) => t.referenceId);
    const depositsById = new Map(
      (
        await this.prisma.deposit.findMany({
          where: { id: { in: referencedDepositIds } },
          select: { id: true, assetNetworkId: true, status: true, ledgerTransactionId: true },
        })
      ).map((d) => [d.id, d]),
    );

    for (const txn of depositLedgerTxns) {
      const referencedDeposit = depositsById.get(txn.referenceId);
      // Only in scope for THIS asset/network's run -- the same asset can
      // have ledger transactions from a different network's deposits.
      if (!referencedDeposit || referencedDeposit.assetNetworkId !== assetNetworkId) continue;
      if (referencedDeposit.status !== DepositStatus.CREDITED || referencedDeposit.ledgerTransactionId !== txn.id) {
        findings.push(
          discrepancy(
            "ledger_transaction_missing_credited_deposit",
            `Ledger transaction ${txn.id} posted a deposit credit, but deposit ${referencedDeposit.id} is not CREDITED (or points at a different transaction).`,
            { ledgerTransactionId: txn.id, depositId: referencedDeposit.id, depositStatus: referencedDeposit.status },
          ),
        );
      }
    }

    return findings;
  }

  /**
   * Flags an asset/network whose scan cursor hasn't recorded a
   * successful scan recently — a watcher that's silently stopped
   * making progress (crashed, misconfigured, or every attempt failing)
   * would otherwise look identical to "no new deposits", which is
   * exactly the ambiguity requirement #8 warns against. WARNING, not
   * CRITICAL: on its own this says nothing about a specific missed
   * deposit, only that watching itself may not be healthy.
   */
  private async checkStaleCursor(assetNetworkId: string): Promise<ReconciliationDiscrepancy[]> {
    const cursor = await this.prisma.blockchainWatchCursor.findUnique({ where: { assetNetworkId } });
    if (!cursor) return []; // never scanned yet -- not itself a discrepancy (e.g. a newly-configured asset/network)

    const referenceTime = cursor.lastSuccessAt ?? cursor.updatedAt;
    const staleForMs = Date.now() - referenceTime.getTime();
    if (staleForMs <= STALE_CURSOR_THRESHOLD_MS) return [];

    return [
      discrepancy("stale_watcher_cursor", `This asset/network's deposit watcher has not completed a successful scan in over ${Math.round(staleForMs / 60_000)} minute(s).`, {
        lastSuccessAt: cursor.lastSuccessAt?.toISOString() ?? null,
        lastError: cursor.lastError,
        lastErrorAt: cursor.lastErrorAt?.toISOString() ?? null,
        staleForMs,
      }),
    ];
  }

  private async sumCreditedDeposits(walletAddressId: string): Promise<Prisma.Decimal> {
    const result = await this.prisma.deposit.aggregate({
      where: { walletAddressId, status: DepositStatus.CREDITED },
      _sum: { amount: true },
    });
    return result._sum.amount ?? new Prisma.Decimal(0);
  }

  async listRuns(assetNetworkId: string) {
    return this.prisma.reconciliationRun.findMany({
      where: { assetNetworkId },
      orderBy: { runAt: "desc" },
      take: 50,
    });
  }
}
