/**
 * Phase 12A restore-verification drill (Part 18).
 *
 * This is a REAL, executable restore test, not a description of one —
 * see docs/database-backup-recovery.md's "Restore verification status"
 * section for how to run it and what it actually proves/doesn't prove.
 *
 * What it does:
 *   1. Starts a real, disposable Postgres instance ("primary") using the
 *      same embedded-postgres package the integration test suite already
 *      uses — no new infra dependency.
 *   2. Applies the real, committed Prisma migrations and seed data.
 *   3. Inserts a real, small sample row for EVERY financial table
 *      category Phase 22 requires a restore to prove recoverable: a
 *      user, a balanced double-entry ledger transaction, a fund
 *      reservation, an order pair + fill + position, a position
 *      settlement (with its own real settlement ledger transaction), a
 *      credited deposit, a requested withdrawal, and a reconciliation
 *      run + discrepancy — not just "the server started".
 *   4. Cleanly stops the primary (flushing WAL) and takes a cold
 *      filesystem-level physical backup — a real, standard Postgres
 *      backup method (https://www.postgresql.org/docs/current/backup-file.html),
 *      chosen because this embedded distribution ships no pg_dump/
 *      pg_restore/psql binaries (server + pg_ctl + initdb only).
 *   5. Starts a SECOND, separate instance directly against the backup
 *      copy — simulating a real restore onto a fresh host.
 *   6. Runs read queries and financial-integrity checks (Part 19)
 *      against the restored instance and reports pass/fail honestly.
 *
 * What this does NOT prove: WAL-based point-in-time recovery (the
 * embedded distribution has no pg_basebackup/WAL-archiving tooling to
 * exercise that path), performance/duration at production data volume,
 * or anything about whatever managed-Postgres provider a real deployment
 * ultimately uses — see docs/database-backup-recovery.md for the exact
 * production prerequisite this drill stands in for.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const EmbeddedPostgres = require("embedded-postgres").default;
const { runIntegrityChecks } = require("./financial-integrity-checks");

const ROOT = path.join(__dirname, "..");
const PRIMARY_DIR = path.join(ROOT, ".backup-drill-primary");
const RESTORED_DIR = path.join(ROOT, ".backup-drill-restored");
const PRIMARY_PORT = 55601;
const RESTORED_PORT = 55602;
const PG_USER = "drilluser";
const PG_PASSWORD = "drillpassword";
const DB_NAME = "verdictvaut_backup_drill";

const results = [];
function check(label, passed, detail) {
  results.push({ label, passed, detail });
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${label}${detail ? " — " + detail : ""}`);
}

function cleanDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  console.log("=== Phase 12A backup/restore drill ===\n");
  cleanDir(PRIMARY_DIR);
  cleanDir(RESTORED_DIR);

  console.log("1. Starting primary instance...");
  const primary = new EmbeddedPostgres({
    databaseDir: PRIMARY_DIR,
    user: PG_USER,
    password: PG_PASSWORD,
    port: PRIMARY_PORT,
    persistent: true,
  });
  await primary.initialise();
  await primary.start();
  await primary.createDatabase(DB_NAME);
  const primaryUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${PRIMARY_PORT}/${DB_NAME}`;

  console.log("2. Applying the real, committed migrations + seed...");
  execSync("npx prisma migrate deploy", { cwd: ROOT, env: { ...process.env, DATABASE_URL: primaryUrl }, stdio: "inherit" });
  execSync("npx prisma db seed", { cwd: ROOT, env: { ...process.env, DATABASE_URL: primaryUrl }, stdio: "inherit" });

  console.log("\n3. Inserting sample financial data to verify after restore...");
  const { PrismaClient } = require("@prisma/client");
  const primaryPrisma = new PrismaClient({ datasourceUrl: primaryUrl });
  const marker = `drill-${Date.now()}`;
  const user = await primaryPrisma.user.create({ data: { email: `${marker}@example.com`, passwordHash: "unused", status: "ACTIVE" } });
  const counterparty = await primaryPrisma.user.create({ data: { email: `${marker}-counterparty@example.com`, passwordHash: "unused", status: "ACTIVE" } });
  const usdc = await primaryPrisma.asset.findUniqueOrThrow({ where: { symbol: "USDC" } });

  // Phase 32 — moved ahead of the ledger rows below (was created much
  // later in this script) so the deposit-backing LedgerTransaction can
  // carry a real referenceType: 'Deposit' / referenceId: deposit.id pair,
  // exactly like DepositsService.creditDeposit's real shape
  // (deposits.service.ts) — required for
  // financial-integrity-checks.js's orphan-LedgerTransaction check
  // (#15, Phase 32) to recognize this row rather than flag it.
  const usdcSepoliaNetwork = await primaryPrisma.assetNetwork.findFirstOrThrow({
    where: { asset: { symbol: "USDC" }, network: { code: "ethereum-sepolia" } },
  });
  const walletAddress = await primaryPrisma.walletAddress.create({
    data: { assetNetworkId: usdcSepoliaNetwork.id, address: `0xdrill${Date.now()}`, role: "DEPOSIT_POOL", environment: "SANDBOX", status: "ASSIGNED" },
  });
  // Created PENDING (no ledgerTransactionId yet — deposits_credited_ledger_ref_consistency_check
  // forbids a non-CREDITED deposit from carrying one) and credited further
  // below once its backing LedgerTransaction exists, the same two-step
  // order the real DepositsService.creditDeposit flow uses.
  const deposit = await primaryPrisma.deposit.create({
    data: {
      userId: user.id,
      assetId: usdc.id,
      assetNetworkId: usdcSepoliaNetwork.id,
      walletAddressId: walletAddress.id,
      txHash: `0xdrilldeposit${Date.now()}`,
      amount: "100",
      confirmations: 0,
      requiredConfirmations: 12,
      status: "PENDING",
    },
  });

  const externalChain = await primaryPrisma.ledgerAccount.create({
    data: { ownerType: "HOUSE", houseAccountKey: "EXTERNAL_CHAIN", assetId: usdc.id, cachedBalance: "-100", reservedBalance: "0" },
  });
  const userAccount = await primaryPrisma.ledgerAccount.create({
    data: { ownerType: "USER", userId: user.id, assetId: usdc.id, cachedBalance: "100", reservedBalance: "0" },
  });
  const txn = await primaryPrisma.ledgerTransaction.create({
    data: { assetId: usdc.id, type: "DEPOSIT", referenceType: "Deposit", referenceId: deposit.id, idempotencyKey: `deposit:${deposit.id}` },
  });
  // Phase 32 — both legs of one LedgerTransaction must commit together:
  // ledger_entries_transaction_balance_check (a DEFERRED CONSTRAINT
  // TRIGGER, migration 20260919010000) verifies at COMMIT time that
  // every transactionId's entries sum to zero, so two separate
  // auto-committing .create() calls would fail on the first one (its own
  // implicit transaction sees only a single, unbalanced leg).
  await primaryPrisma.$transaction([
    primaryPrisma.ledgerEntry.create({ data: { transactionId: txn.id, accountId: userAccount.id, amount: "100", balanceAfter: "100" } }),
    primaryPrisma.ledgerEntry.create({ data: { transactionId: txn.id, accountId: externalChain.id, amount: "-100", balanceAfter: "-100" } }),
  ]);
  await primaryPrisma.deposit.update({
    where: { id: deposit.id },
    data: { status: "CREDITED", confirmations: 12, ledgerTransactionId: txn.id, creditedAt: new Date() },
  });

  // Phase 22 — broadened beyond the ledger core (Phase 12A's original
  // scope) to cover every table category the phase brief explicitly asks
  // a restore to prove recoverable: reservations, orders/fills/positions,
  // deposits/withdrawals, reconciliation records, and settlement records.
  // All inserted directly (not through application services) — same
  // methodology the ledger rows above already use — this drill tests
  // DATABASE restorability, not business-logic correctness (that's what
  // the integration-test suite is for).
  const reservation = await primaryPrisma.fundReservation.create({
    data: { accountId: userAccount.id, amount: "10", consumedAmount: "0", status: "ACTIVE", referenceType: "BackupDrill", referenceId: marker, idempotencyKey: `drill-reservation:${marker}` },
  });
  // Phase 32 — ReservationService.reserve() always bumps the owning
  // account's cachedBalance-adjacent reservedBalance in the same
  // transaction as the FundReservation row (reservation.service.ts);
  // this direct insert must mirror that or
  // financial-integrity-checks.js's reservedBalance-vs-FundReservations
  // cross-check (#10) reports a drift that was never real (nothing
  // actually released or over-reserved — the fixture just never set it).
  await primaryPrisma.ledgerAccount.update({ where: { id: userAccount.id }, data: { reservedBalance: "10" } });

  const category = await primaryPrisma.marketCategory.create({ data: { slug: `drill-category-${marker}`, name: "Backup Drill Category" } });
  const market = await primaryPrisma.market.create({
    data: { slug: `drill-market-${marker}`, title: "Backup drill market", description: "Sample market for restore verification", categoryId: category.id, status: "OPEN", createdById: user.id },
  });
  const yesOutcome = await primaryPrisma.marketOutcome.create({ data: { marketId: market.id, key: "YES", label: "Yes" } });
  await primaryPrisma.marketOutcome.create({ data: { marketId: market.id, key: "NO", label: "No" } });

  const buyOrder = await primaryPrisma.order.create({
    data: { userId: user.id, marketId: market.id, outcomeId: yesOutcome.id, side: "BUY", type: "LIMIT", price: "0.5", quantity: "5", filledQuantity: "5", remainingQuantity: "0", status: "FILLED", clientOrderId: `drill-buy:${marker}` },
  });
  const sellOrder = await primaryPrisma.order.create({
    data: { userId: counterparty.id, marketId: market.id, outcomeId: yesOutcome.id, side: "SELL", type: "LIMIT", price: "0.5", quantity: "5", filledQuantity: "5", remainingQuantity: "0", status: "FILLED", clientOrderId: `drill-sell:${marker}` },
  });
  const fill = await primaryPrisma.fill.create({
    data: {
      marketId: market.id,
      outcomeId: yesOutcome.id,
      buyOrderId: buyOrder.id,
      sellOrderId: sellOrder.id,
      makerOrderId: sellOrder.id,
      takerOrderId: buyOrder.id,
      buyerUserId: user.id,
      sellerUserId: counterparty.id,
      price: "0.5",
      quantity: "5",
      idempotencyKey: `drill-fill:${marker}`,
    },
  });
  // Phase 32 — ExecutionCoordinator.postTradeLedger (execution-coordinator.service.ts)
  // always posts a real trade this same shape (referenceType: 'Fill',
  // referenceId: fill.id, buyer debit / seller credit) in the SAME
  // transaction as the Fill row itself; financial-integrity-checks.js's
  // check #12 independently verifies every Fill has exactly this backing
  // record, so the fixture must have one too.
  const counterpartyAccount = await primaryPrisma.ledgerAccount.create({
    data: { ownerType: "USER", userId: counterparty.id, assetId: usdc.id, cachedBalance: "2.5", reservedBalance: "0" },
  });
  const fillTxn = await primaryPrisma.ledgerTransaction.create({
    data: { assetId: usdc.id, type: "TRADE", referenceType: "Fill", referenceId: fill.id, idempotencyKey: `trade:${fill.id}` },
  });
  await primaryPrisma.$transaction([
    primaryPrisma.ledgerEntry.create({ data: { transactionId: fillTxn.id, accountId: userAccount.id, amount: "-2.5", balanceAfter: "97.5" } }),
    primaryPrisma.ledgerEntry.create({ data: { transactionId: fillTxn.id, accountId: counterpartyAccount.id, amount: "2.5", balanceAfter: "2.5" } }),
  ]);
  const position = await primaryPrisma.position.create({
    data: { userId: user.id, marketId: market.id, outcomeId: yesOutcome.id, quantity: "5", avgPrice: "0.5" },
  });
  // A nonzero payoutAmount requires a real ledgerTransactionId
  // (position_settlements_ledger_ref_consistency_check) — the market's
  // own collateral account funds the payout, same shape as the real
  // SettlementService's own real-money settlement path.
  const marketCollateralAccount = await primaryPrisma.ledgerAccount.create({
    data: { ownerType: "MARKET", marketId: market.id, assetId: usdc.id, cachedBalance: "5", reservedBalance: "0" },
  });
  // Phase 32 — SettlementService's real settlement payout uses exactly
  // this shape (referenceType: 'Position', referenceId: position.id —
  // settlement.service.ts); financial-integrity-checks.js's orphan-
  // LedgerTransaction check (#15) only recognizes that referenceType
  // together with a real Position id, not an arbitrary marker string.
  const settlementTxn = await primaryPrisma.ledgerTransaction.create({
    data: { assetId: usdc.id, type: "SETTLEMENT", referenceType: "Position", referenceId: position.id, idempotencyKey: `settlement-payout:${position.id}` },
  });
  // Phase 32 — same reason as the deposit-leg pair above.
  await primaryPrisma.$transaction([
    primaryPrisma.ledgerEntry.create({ data: { transactionId: settlementTxn.id, accountId: userAccount.id, amount: "5", balanceAfter: "105" } }),
    primaryPrisma.ledgerEntry.create({ data: { transactionId: settlementTxn.id, accountId: marketCollateralAccount.id, amount: "-5", balanceAfter: "0" } }),
  ]);
  const settlement = await primaryPrisma.positionSettlement.create({
    data: { positionId: position.id, marketId: market.id, outcomeId: yesOutcome.id, userId: user.id, quantity: "5", payoutPerShare: "1", payoutAmount: "5", ledgerTransactionId: settlementTxn.id, idempotencyKey: `drill-settlement:${marker}` },
  });
  await primaryPrisma.position.update({ where: { id: position.id }, data: { settledAt: settlement.settledAt } });

  // usdcSepoliaNetwork/walletAddress/deposit were created earlier
  // (Phase 32 — moved up so the deposit-backing LedgerTransaction can
  // reference a real deposit.id); reused here for the withdrawal fixture.
  const withdrawal = await primaryPrisma.withdrawal.create({
    data: {
      userId: user.id,
      assetNetworkId: usdcSepoliaNetwork.id,
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
      amount: "10",
      status: "REQUESTED",
      clientWithdrawalId: `drill-withdrawal:${marker}`,
    },
  });

  const reconciliationRun = await primaryPrisma.reconciliationRun.create({
    data: { assetNetworkId: usdcSepoliaNetwork.id, status: "OK", runType: "INDEPENDENT_RESCAN" },
  });
  const discrepancy = await primaryPrisma.reconciliationDiscrepancy.create({
    data: {
      runId: reconciliationRun.id,
      assetNetworkId: usdcSepoliaNetwork.id,
      type: "backup_drill_sample_discrepancy",
      severity: "INFO",
      chainIdentity: `drill:${marker}`,
      expectedState: { note: "sample expected state for restore verification" },
      observedState: { note: "sample observed state for restore verification" },
      status: "OPEN",
      idempotencyKey: `drill-discrepancy:${marker}`,
    },
  });

  // Phase 39 — two more table categories whose loss would matter after a
  // restore: the audit trail (forensics) and worker job state (Phase 35
  // leases/heartbeats — a restore that dropped it would make every
  // scheduled job due at once, harmless but worth proving restored).
  const auditRow = await primaryPrisma.auditLog.create({
    data: { actorType: "SYSTEM", action: "backup_drill.sample", resourceType: "Withdrawal", resourceId: withdrawal.id, after: { marker } },
  });
  const jobStateRow = await primaryPrisma.scheduledJobState.create({
    data: { jobKey: `drill-job:${marker}`, lastStartedAt: new Date(), lastSuccessAt: new Date(), lastSummary: "drill" },
  });

  const migrationCountBefore = await primaryPrisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL');
  await primaryPrisma.$disconnect();

  console.log("\n4. Stopping primary cleanly (flushing WAL) before taking a physical backup...");
  await primary.stop();

  console.log("5. Taking a cold physical backup (filesystem copy of the stopped data directory)...");
  fs.cpSync(PRIMARY_DIR, RESTORED_DIR, { recursive: true });
  // A copied data directory can carry a stale postmaster.pid from the
  // (now-stopped) primary — a real restore onto a fresh host wouldn't
  // have one; remove it so Postgres doesn't mistake this for "already running".
  const stalePidFile = path.join(RESTORED_DIR, "postmaster.pid");
  if (fs.existsSync(stalePidFile)) fs.rmSync(stalePidFile);

  console.log("6. Starting a SEPARATE instance directly from the backup copy (simulating a real restore)...");
  const restored = new EmbeddedPostgres({
    databaseDir: RESTORED_DIR,
    user: PG_USER,
    password: PG_PASSWORD,
    port: RESTORED_PORT,
    persistent: true,
  });
  // Deliberately NOT calling .initialise() — that would re-run initdb and
  // destroy the restored data. This is the entire point of the drill:
  // starting Postgres against a pre-existing (restored) data directory.
  await restored.start();
  const restoredUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@localhost:${RESTORED_PORT}/${DB_NAME}`;
  const restoredPrisma = new PrismaClient({ datasourceUrl: restoredUrl });

  console.log("\n7. Verifying the restored instance...\n");
  try {
    const restoredUser = await restoredPrisma.user.findUnique({ where: { id: user.id } });
    check("restored user record exists with matching email", restoredUser?.email === user.email);

    const restoredAccount = await restoredPrisma.ledgerAccount.findUnique({ where: { id: userAccount.id } });
    check("restored ledger account balance intact", restoredAccount?.cachedBalance.toString() === "100");

    const entries = await restoredPrisma.ledgerEntry.findMany({ where: { transactionId: txn.id } });
    const sum = entries.reduce((s, e) => s.plus(e.amount), new (require("@prisma/client").Prisma.Decimal)(0));
    check("restored ledger transaction still balances to exactly zero", sum.isZero(), `sum=${sum.toString()}`);

    // Phase 22 — every additional table category inserted in step 3.
    const restoredReservation = await restoredPrisma.fundReservation.findUnique({ where: { id: reservation.id } });
    check("restored FundReservation recovered with matching amount", restoredReservation?.amount.toString() === "10");

    const restoredOrders = await restoredPrisma.order.findMany({ where: { id: { in: [buyOrder.id, sellOrder.id] } } });
    check("both restored orders recovered", restoredOrders.length === 2);

    const restoredFill = await restoredPrisma.fill.findUnique({ where: { id: fill.id } });
    check("restored Fill recovered with matching quantity", restoredFill?.quantity.toString() === "5");

    const restoredPosition = await restoredPrisma.position.findUnique({ where: { id: position.id } });
    check("restored Position recovered, settled", restoredPosition?.settledAt != null);

    const restoredSettlement = await restoredPrisma.positionSettlement.findUnique({ where: { id: settlement.id } });
    check("restored PositionSettlement recovered with matching payoutAmount", restoredSettlement?.payoutAmount.toString() === "5");

    const restoredDeposit = await restoredPrisma.deposit.findUnique({ where: { id: deposit.id } });
    check("restored CREDITED Deposit recovered with its ledgerTransactionId intact", restoredDeposit?.ledgerTransactionId === txn.id);

    const restoredWithdrawal = await restoredPrisma.withdrawal.findUnique({ where: { id: withdrawal.id } });
    check("restored Withdrawal recovered with matching status", restoredWithdrawal?.status === "REQUESTED");

    const restoredDiscrepancy = await restoredPrisma.reconciliationDiscrepancy.findUnique({ where: { id: discrepancy.id } });
    check("restored ReconciliationDiscrepancy recovered with matching chainIdentity", restoredDiscrepancy?.chainIdentity === `drill:${marker}`);

    const restoredAudit = await restoredPrisma.auditLog.findUnique({ where: { id: auditRow.id } });
    check("restored AuditLog row recovered with matching action and target", restoredAudit?.action === "backup_drill.sample" && restoredAudit?.resourceId === withdrawal.id);

    const restoredJob = await restoredPrisma.scheduledJobState.findUnique({ where: { jobKey: jobStateRow.jobKey } });
    check("restored ScheduledJobState recovered with its lastSuccessAt", restoredJob?.lastSuccessAt?.getTime() === jobStateRow.lastSuccessAt.getTime());

    const migrationCountAfter = await restoredPrisma.$queryRawUnsafe(
      'SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );
    check(
      "migration history intact",
      migrationCountAfter[0].count === migrationCountBefore[0].count,
      `before=${migrationCountBefore[0].count} after=${migrationCountAfter[0].count}`,
    );

    // The full reusable financial integrity suite (Part 19) — the same
    // checks a real restore's step 7 (docs/database-backup-recovery.md)
    // and a periodic health check (`npm run check:integrity`) use, run
    // here against the just-restored instance so this drill genuinely
    // exercises the same verification path an operator would use.
    const integrityResults = await runIntegrityChecks(restoredPrisma);
    for (const r of integrityResults) {
      check(`[integrity] ${r.label}`, r.passed, r.detail);
    }
  } finally {
    await restoredPrisma.$disconnect();
  }

  console.log("\n8. Tearing down both instances and cleaning up...");
  await restored.stop();
  cleanDir(PRIMARY_DIR);
  cleanDir(RESTORED_DIR);

  const allPassed = results.every((r) => r.passed);
  console.log(`\n=== Drill ${allPassed ? "PASSED" : "FAILED"} (${results.filter((r) => r.passed).length}/${results.length} checks) ===`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
  console.error("Backup/restore drill crashed:", error);
  process.exit(1);
});
