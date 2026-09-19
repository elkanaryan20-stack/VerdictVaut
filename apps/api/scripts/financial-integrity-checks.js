/**
 * Phase 12A reusable financial integrity checks (Part 19). Runs against
 * whatever Prisma client is handed to it — usable during development,
 * after a database restore (see docs/database-backup-recovery.md), the
 * backup/restore drill, during an operational incident, or as a
 * standalone periodic health check (see runAsCli below / `npm run
 * check:integrity`). Every check states a specific pass/fail reason —
 * never just "something is wrong".
 *
 * Read-only. Never mutates anything, regardless of what it finds.
 */

/** @param {import("@prisma/client").PrismaClient} prisma */
async function runIntegrityChecks(prisma) {
  const { Prisma } = require("@prisma/client");
  const results = [];
  const check = (label, passed, detail) => {
    results.push({ label, passed, detail });
    return passed;
  };

  // 1. Every ledger transaction's entries sum to exactly zero — the
  // core double-entry invariant, audited independently of the
  // application-level check LedgerService.postTransaction already does
  // before every write (this catches a violation from BEFORE that check
  // existed, or from direct DB tampering/a bad restore).
  const txns = await prisma.ledgerTransaction.findMany({ select: { id: true } });
  let unbalanced = 0;
  for (const { id } of txns) {
    const entries = await prisma.ledgerEntry.findMany({ where: { transactionId: id } });
    const sum = entries.reduce((s, e) => s.plus(e.amount), new Prisma.Decimal(0));
    if (!sum.isZero()) unbalanced += 1;
  }
  check("every ledger transaction balances to zero", unbalanced === 0, `${unbalanced} of ${txns.length} unbalanced`);

  // 2. No USER/MARKET-owned ledger account violates the non-negative-
  // balance invariant (DB CHECK constraint backstop, audited
  // independently — a constraint addition doesn't retroactively check
  // pre-existing rows from an older schema version restored from backup).
  const negativeAccounts = await prisma.$queryRaw`
    SELECT id FROM "ledger_accounts"
    WHERE "ownerType" != 'HOUSE' AND ("cachedBalance" < 0 OR "reservedBalance" < 0 OR "cachedBalance" < "reservedBalance")
  `;
  check("no USER/MARKET ledger account violates the non-negative-balance invariant", negativeAccounts.length === 0, `${negativeAccounts.length} violation(s)`);

  // 3. Reservation consistency: consumedAmount always within [0, amount].
  const badFundReservations = await prisma.$queryRaw`
    SELECT id FROM "fund_reservations" WHERE "consumedAmount" < 0 OR "consumedAmount" > "amount"
  `;
  check("every FundReservation's consumedAmount is within [0, amount]", badFundReservations.length === 0, `${badFundReservations.length} violation(s)`);

  const badPositionReservations = await prisma.$queryRaw`
    SELECT id FROM "position_reservations" WHERE "consumedAmount" < 0 OR "consumedAmount" > "amount"
  `;
  check("every PositionReservation's consumedAmount is within [0, amount]", badPositionReservations.length === 0, `${badPositionReservations.length} violation(s)`);

  // 4. Every CREDITED deposit has real ledger evidence.
  const creditedDeposits = await prisma.deposit.findMany({ where: { status: "CREDITED" }, select: { id: true, ledgerTransactionId: true } });
  const missingLedgerRef = creditedDeposits.filter((d) => !d.ledgerTransactionId);
  check("every CREDITED deposit has a ledgerTransactionId", missingLedgerRef.length === 0, `${missingLedgerRef.length} of ${creditedDeposits.length} missing`);

  // 5. Every settled position has exactly one PositionSettlement — the
  // unique constraints on Position.settledAt-implies-PositionSettlement
  // enforce this at write time; audited independently here too.
  const settledPositions = await prisma.position.count({ where: { settledAt: { not: null } } });
  const settlementRows = await prisma.positionSettlement.count();
  check("settled-position count matches PositionSettlement row count", settledPositions === settlementRows, `positions=${settledPositions} settlements=${settlementRows}`);

  // 6. Payout amount matches quantity * payoutPerShare for every settlement.
  const settlements = await prisma.positionSettlement.findMany({ select: { id: true, quantity: true, payoutPerShare: true, payoutAmount: true } });
  let payoutMismatches = 0;
  for (const s of settlements) {
    const expected = new Prisma.Decimal(s.quantity).times(s.payoutPerShare);
    if (!expected.equals(s.payoutAmount)) payoutMismatches += 1;
  }
  check("every settlement's payoutAmount equals quantity * payoutPerShare", payoutMismatches === 0, `${payoutMismatches} of ${settlements.length} mismatched`);

  // 7. Collateral sufficiency (Phase 12A): for every RESOLVED market,
  // its collateral account must be able to fully cover every winning
  // payout — i.e. by the time settlement finishes, collateral reaches
  // exactly zero (see SettlementService), never negative in the
  // meantime. Negative would already be caught by check #2 (MARKET is
  // non-HOUSE); this check instead looks for the OTHER failure mode —
  // a RESOLVED market whose collateral account still holds a nonzero
  // balance, meaning settlement finished without fully consuming (or
  // over-consumed, impossible under check #2) the collateral it should
  // have exactly zeroed out.
  const resolvedMarketsWithCollateral = await prisma.$queryRaw`
    SELECT m.id, la."cachedBalance" FROM "markets" m
    JOIN "ledger_accounts" la ON la."marketId" = m.id
    WHERE m.status = 'RESOLVED' AND la."cachedBalance" != 0
  `;
  check(
    "every RESOLVED market's collateral account reached exactly zero",
    resolvedMarketsWithCollateral.length === 0,
    `${resolvedMarketsWithCollateral.length} market(s) with leftover/negative collateral`,
  );

  // 8. Withdrawal state consistency (Phase 22) — independently audits the
  // SAME invariant "withdrawals_broadcast_requires_txhash_check" (Phase
  // 9) already enforces at write time: a withdrawal can never be
  // BROADCAST/CONFIRMING/CONFIRMED/CREDITED with no real txHash on
  // record. A live DB CHECK constraint only protects writes made AFTER
  // the constraint existed — this catches the same violation in data
  // that predates it, e.g. a restore from an older schema version.
  const badWithdrawals = await prisma.$queryRaw`
    SELECT id FROM "withdrawals"
    WHERE status IN ('BROADCAST', 'CONFIRMING', 'CONFIRMED', 'CREDITED') AND "txHash" IS NULL
  `;
  check(
    "every BROADCAST/CONFIRMING/CONFIRMED/CREDITED withdrawal has a real txHash",
    badWithdrawals.length === 0,
    `${badWithdrawals.length} violation(s)`,
  );

  // 9. Reconciliation discrepancy resolution consistency (Phase 22) —
  // independently audits "reconciliation_discrepancies_resolution_
  // consistency_check" (Phase 12A): a RESOLVED/FALSE_POSITIVE row must
  // carry who/when closed it; an OPEN/ACKNOWLEDGED row must not. Same
  // "pre-existing-data" reasoning as check 8 — this is a read-only audit,
  // never a repair; a violation here is reported, never silently fixed.
  const badDiscrepancies = await prisma.$queryRaw`
    SELECT id FROM "reconciliation_discrepancies"
    WHERE (status IN ('RESOLVED', 'FALSE_POSITIVE') AND ("resolvedAt" IS NULL OR "resolvedByUserId" IS NULL))
       OR (status IN ('OPEN', 'ACKNOWLEDGED') AND ("resolvedAt" IS NOT NULL OR "resolvedByUserId" IS NOT NULL))
  `;
  check(
    "every ReconciliationDiscrepancy's resolution fields are consistent with its status",
    badDiscrepancies.length === 0,
    `${badDiscrepancies.length} violation(s)`,
  );

  // 10. Phase 31 — cross-validates the INCREMENTALLY-maintained
  // LedgerAccount.reservedBalance "cache" (updated by
  // ReservationService.reserve/consume/release, never recomputed from
  // scratch) against the actual source-of-truth FundReservation rows.
  // These are two representations of the same fact that could in
  // principle drift apart from an application bug; this does not
  // create a second source of truth, it audits the existing cache
  // against the existing ledger of reservations, the same "independently
  // audit a derived/cached field" pattern check #2/#7 above already use.
  const reservedBalanceMismatches = await prisma.$queryRaw`
    SELECT la.id
    FROM "ledger_accounts" la
    LEFT JOIN "fund_reservations" fr ON fr."accountId" = la.id AND fr.status = 'ACTIVE'
    GROUP BY la.id, la."reservedBalance"
    HAVING la."reservedBalance" != COALESCE(SUM(fr.amount - fr."consumedAmount"), 0)
  `;
  check(
    "every LedgerAccount.reservedBalance equals the sum of its ACTIVE FundReservations' unconsumed amounts",
    reservedBalanceMismatches.length === 0,
    `${reservedBalanceMismatches.length} account(s) with a drifted reservedBalance`,
  );

  // 11. Same cross-validation, for the position/share-reservation side
  // (PositionReservationService.reserve/consume/release maintains
  // Position.reservedQuantity the same incremental way).
  const reservedQuantityMismatches = await prisma.$queryRaw`
    SELECT p.id
    FROM "positions" p
    LEFT JOIN "position_reservations" pr ON pr."positionId" = p.id AND pr.status = 'ACTIVE'
    GROUP BY p.id, p."reservedQuantity"
    HAVING p."reservedQuantity" != COALESCE(SUM(pr.amount - pr."consumedAmount"), 0)
  `;
  check(
    "every Position.reservedQuantity equals the sum of its ACTIVE PositionReservations' unconsumed amounts",
    reservedQuantityMismatches.length === 0,
    `${reservedQuantityMismatches.length} position(s) with a drifted reservedQuantity`,
  );

  // 12. Every Fill must have a backing LedgerTransaction — the trade
  // that moved real value never happened without the double-entry
  // record of it (ExecutionCoordinator.postTradeLedger posts this in
  // the SAME transaction as the Fill row itself, so this should be
  // structurally impossible to violate under normal operation; this
  // audits it independently, the same "catch data that predates a
  // guarantee, e.g. after a restore" reasoning as check #8/#9).
  const fillsWithoutLedgerEntry = await prisma.$queryRaw`
    SELECT f.id FROM "fills" f
    WHERE NOT EXISTS (
      SELECT 1 FROM "ledger_transactions" lt
      WHERE lt."referenceType" = 'Fill' AND lt."referenceId" = f.id
    )
  `;
  check(
    "every Fill has a backing LedgerTransaction",
    fillsWithoutLedgerEntry.length === 0,
    `${fillsWithoutLedgerEntry.length} of however many Fills total, missing a ledger record`,
  );

  // 13. Fee reconciliation — sum(Fill.fee) must equal every FEE_REVENUE
  // house account's total credited balance, per asset. Currently a
  // trivial always-zero-equals-zero check (ZeroFeeCalculator — see
  // trading/fees/zero-fee.calculator.ts's own docblock, unchanged by
  // this phase), but the assertion is real and forward-safe: the
  // moment a non-zero FeeCalculator is ever wired in, this starts
  // meaningfully verifying fee revenue actually reconciles rather than
  // silently never having been checked at all.
  const feeReconciliation = await prisma.$queryRaw`
    SELECT
      COALESCE((SELECT SUM(fee) FROM "fills"), 0) AS "totalFillFees",
      COALESCE((
        SELECT SUM(la."cachedBalance")
        FROM "ledger_accounts" la
        WHERE la."ownerType" = 'HOUSE' AND la."houseAccountKey" = 'FEE_REVENUE'
      ), 0) AS "totalFeeRevenue"
  `;
  const { totalFillFees, totalFeeRevenue } = feeReconciliation[0];
  check(
    "total Fill.fee across every fill equals the FEE_REVENUE house account balance",
    new Prisma.Decimal(totalFillFees).equals(new Prisma.Decimal(totalFeeRevenue)),
    `fills=${totalFillFees} feeRevenueAccount=${totalFeeRevenue}`,
  );

  // 14. Orphan ACTIVE reservations (Phase 32) — an ACTIVE FundReservation/
  // PositionReservation earmarks real balance/shares against a specific
  // Order or Withdrawal (see reservation.service.ts's `referenceType`/
  // `referenceId`); if that referenced row no longer exists at all, the
  // earmark can never be released or consumed by anything (every release/
  // consume path is reached BY loading the order/withdrawal first), so
  // the user's available balance would be permanently understated with
  // no code path left that could ever fix it — the same category of harm
  // as the Phase 31 stranded-reservation bug, but from the row-existence
  // side rather than the consumed-amount side.
  const orphanFundReservations = await prisma.$queryRaw`
    SELECT fr.id FROM "fund_reservations" fr
    WHERE fr.status = 'ACTIVE'
      AND (
        (fr."referenceType" = 'Order' AND NOT EXISTS (SELECT 1 FROM "orders" o WHERE o.id = fr."referenceId"))
        OR (fr."referenceType" = 'Withdrawal' AND NOT EXISTS (SELECT 1 FROM "withdrawals" w WHERE w.id = fr."referenceId"))
      )
  `;
  check(
    "every ACTIVE FundReservation references a real, still-existing Order or Withdrawal",
    orphanFundReservations.length === 0,
    `${orphanFundReservations.length} orphaned ACTIVE FundReservation(s)`,
  );

  const orphanPositionReservations = await prisma.$queryRaw`
    SELECT pr.id FROM "position_reservations" pr
    WHERE pr.status = 'ACTIVE'
      AND pr."referenceType" = 'Order'
      AND NOT EXISTS (SELECT 1 FROM "orders" o WHERE o.id = pr."referenceId")
  `;
  check(
    "every ACTIVE PositionReservation references a real, still-existing Order",
    orphanPositionReservations.length === 0,
    `${orphanPositionReservations.length} orphaned ACTIVE PositionReservation(s)`,
  );

  // 15. Orphan LedgerTransaction (Phase 32) — every LedgerTransaction
  // carries a `referenceType`/`referenceId` back to the real-world event
  // that caused it (Fill, CompleteSetMint, Deposit, Withdrawal, or
  // Position for a settlement payout — the complete, exhaustive set of
  // referenceType values every postTransaction() call site in the
  // codebase ever uses). A LedgerTransaction whose reference resolves to
  // nothing is a real money movement with no recoverable explanation of
  // WHY it happened — unauditable by construction, and a signal that
  // either the referenced row was wrongly deleted or the ledger entry
  // itself doesn't belong.
  const orphanLedgerTransactions = await prisma.$queryRaw`
    SELECT lt.id, lt."referenceType" FROM "ledger_transactions" lt
    WHERE
      (lt."referenceType" = 'Fill' AND NOT EXISTS (SELECT 1 FROM "fills" f WHERE f.id = lt."referenceId"))
      OR (lt."referenceType" = 'CompleteSetMint' AND NOT EXISTS (SELECT 1 FROM "complete_set_mints" csm WHERE csm.id = lt."referenceId"))
      OR (lt."referenceType" = 'Deposit' AND NOT EXISTS (SELECT 1 FROM "deposits" d WHERE d.id = lt."referenceId"))
      OR (lt."referenceType" = 'Withdrawal' AND NOT EXISTS (SELECT 1 FROM "withdrawals" w WHERE w.id = lt."referenceId"))
      OR (lt."referenceType" = 'Position' AND NOT EXISTS (SELECT 1 FROM "positions" p WHERE p.id = lt."referenceId"))
      OR lt."referenceType" NOT IN ('Fill', 'CompleteSetMint', 'Deposit', 'Withdrawal', 'Position')
  `;
  check(
    "every LedgerTransaction references a real, still-existing Fill/CompleteSetMint/Deposit/Withdrawal/Position",
    orphanLedgerTransactions.length === 0,
    `${orphanLedgerTransactions.length} orphaned/unrecognized-reference LedgerTransaction(s)`,
  );

  return results;
}

async function runAsCli() {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  console.log("=== Financial integrity checks ===\n");
  const results = await runIntegrityChecks(prisma);
  for (const r of results) {
    console.log(`  [${r.passed ? "PASS" : "FAIL"}] ${r.label}${r.detail ? " — " + r.detail : ""}`);
  }
  await prisma.$disconnect();

  const allPassed = results.every((r) => r.passed);
  console.log(`\n=== ${allPassed ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED"} (${results.filter((r) => r.passed).length}/${results.length}) ===`);
  process.exit(allPassed ? 0 : 1);
}

module.exports = { runIntegrityChecks };

if (require.main === module) {
  runAsCli().catch((error) => {
    console.error("Integrity check crashed:", error);
    process.exit(1);
  });
}
