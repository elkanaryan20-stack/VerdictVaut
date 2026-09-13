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
