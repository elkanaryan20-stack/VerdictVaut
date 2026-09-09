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
 *   3. Inserts a small amount of real financial data (a user, a
 *      balanced double-entry ledger transaction) so restoration can be
 *      verified against actual content, not just "the server started".
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
  const usdc = await primaryPrisma.asset.findUniqueOrThrow({ where: { symbol: "USDC" } });
  const externalChain = await primaryPrisma.ledgerAccount.create({
    data: { ownerType: "HOUSE", houseAccountKey: "EXTERNAL_CHAIN", assetId: usdc.id, cachedBalance: "-100", reservedBalance: "0" },
  });
  const userAccount = await primaryPrisma.ledgerAccount.create({
    data: { ownerType: "USER", userId: user.id, assetId: usdc.id, cachedBalance: "100", reservedBalance: "0" },
  });
  const txn = await primaryPrisma.ledgerTransaction.create({
    data: { assetId: usdc.id, type: "DEPOSIT", referenceType: "BackupDrill", referenceId: marker, idempotencyKey: `drill:${marker}` },
  });
  await primaryPrisma.ledgerEntry.create({ data: { transactionId: txn.id, accountId: userAccount.id, amount: "100", balanceAfter: "100" } });
  await primaryPrisma.ledgerEntry.create({ data: { transactionId: txn.id, accountId: externalChain.id, amount: "-100", balanceAfter: "-100" } });
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
