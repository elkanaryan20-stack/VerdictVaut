/**
 * Phase 29 — a static safety scan over NEWLY ADDED Prisma migrations,
 * complementing (not replacing) `guard-destructive-migration.js`
 * (which blocks running a destructive Prisma COMMAND against a
 * production-looking environment) and the migration-safety guidance
 * already documented in docs/production-deployment-plan.md §6/§7 and
 * docs/disaster-recovery-runbooks.md runbook L. This script instead
 * asks a narrower, static question: "does the migration SQL itself,
 * as committed, contain a statement that can silently delete data,
 * with no explicit human acknowledgement in the file."
 *
 * Scope, deliberately narrow: this is a heuristic text scan, not a SQL
 * parser — it can be fooled by unusual formatting and does not
 * understand semantics (e.g. a DROP COLUMN on a column that was just
 * added in the same migration and never shipped is actually safe, but
 * this script cannot tell the difference). It exists to force an
 * explicit, auditable acknowledgement for the COMMON case, not to be a
 * complete guarantee — same "defense in depth, not a substitute for
 * process" framing as guard-destructive-migration.js's own docblock.
 *
 * A migration is FLAGGED if it contains (case-insensitive):
 *   - DROP TABLE
 *   - DROP COLUMN
 *   - TRUNCATE
 *   - a DELETE FROM statement with no WHERE clause
 * ...UNLESS the same migration.sql file also contains a line matching
 * `-- ALLOW-DESTRUCTIVE: <reason>` — an explicit, committed,
 * code-reviewed acknowledgement, not a silent bypass.
 *
 * "Newly added" is determined via `git diff --diff-filter=A <base>..HEAD
 * -- prisma/migrations` against a base ref (default `origin/main`,
 * override with MIGRATION_SAFETY_BASE_REF). If git is unavailable or
 * the base ref cannot be resolved (e.g. a shallow clone, or running
 * directly on main with nothing to diff against), this script falls
 * back to scanning EVERY migration and reports informationally only —
 * it never fails the build in that fallback mode, since it cannot
 * distinguish "always been here, already applied to production" from
 * "just added," and failing on 26 years of accepted history would be
 * exactly the kind of hollow, un-actionable check this repository's
 * tooling philosophy rejects.
 *
 * Usage: node scripts/check-migration-safety.js [--base-ref <ref>]
 * Exit code: 1 only if a NEWLY ADDED migration is flagged with no
 * ALLOW-DESTRUCTIVE acknowledgement; 0 otherwise.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MIGRATIONS_DIR = path.join(__dirname, "..", "prisma", "migrations");

const DANGEROUS_PATTERNS = [
  { name: "DROP TABLE", re: /drop\s+table/i },
  { name: "DROP COLUMN", re: /drop\s+column/i },
  { name: "TRUNCATE", re: /truncate/i },
];

function findUnwhereDeletes(sql) {
  // Split on statement terminators; a DELETE statement with no WHERE
  // anywhere before its own terminating ';' is flagged. Deliberately
  // simple/conservative — a false positive here just means an
  // unnecessary ALLOW-DESTRUCTIVE comment, never a silently-missed
  // real one.
  return sql
    .split(";")
    .filter((stmt) => /delete\s+from/i.test(stmt) && !/where/i.test(stmt))
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

// Pure — takes SQL text directly, no filesystem access. Exported
// separately from scanMigrationFile() specifically so it can be unit
// tested with in-memory strings, without needing a real git repo/
// filesystem fixture (see check-migration-safety.spec.ts).
function scanSql(sql) {
  const findings = [];
  for (const { name, re } of DANGEROUS_PATTERNS) {
    if (re.test(sql)) findings.push(name);
  }
  const unwhereDeletes = findUnwhereDeletes(sql);
  if (unwhereDeletes.length > 0) findings.push(`DELETE FROM without WHERE (${unwhereDeletes.length} statement(s))`);

  // [ \t]* (not \s*) between the colon and the reason — \s would also
  // match a newline, letting the regex "find" a reason on the NEXT
  // line (e.g. the destructive statement itself) for a bare
  // "-- ALLOW-DESTRUCTIVE:" with nothing after it on the same line,
  // which must NOT count as acknowledged. Caught by this file's own
  // test/integration/check-migration-safety.integration-spec.ts.
  const acknowledged = /--[ \t]*ALLOW-DESTRUCTIVE:[ \t]*\S/i.test(sql);
  const reasonMatch = sql.match(/--[ \t]*ALLOW-DESTRUCTIVE:[ \t]*(.+)/i);

  return { findings, acknowledged, reason: reasonMatch ? reasonMatch[1].trim() : null };
}

function scanMigrationFile(migrationDirName) {
  const filePath = path.join(MIGRATIONS_DIR, migrationDirName, "migration.sql");
  if (!fs.existsSync(filePath)) return null;
  return scanSql(fs.readFileSync(filePath, "utf8"));
}

function resolveNewMigrationDirs(baseRef) {
  try {
    execFileSync("git", ["rev-parse", "--verify", baseRef], { stdio: "pipe" });
  } catch {
    return null; // base ref does not resolve — caller falls back
  }
  let diffOutput;
  try {
    diffOutput = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", `${baseRef}...HEAD`, "--", "prisma/migrations"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  const dirs = new Set();
  for (const line of diffOutput.split("\n")) {
    const match = line.match(/prisma\/migrations\/([^/]+)\/migration\.sql$/);
    if (match) dirs.add(match[1]);
  }
  return [...dirs];
}

function main() {
  const args = process.argv.slice(2);
  const baseRefIdx = args.indexOf("--base-ref");
  const baseRef = baseRefIdx >= 0 ? args[baseRefIdx + 1] : process.env.MIGRATION_SAFETY_BASE_REF || "origin/main";

  console.log("=== Migration safety scan (Phase 29) ===\n");

  const newDirs = resolveNewMigrationDirs(baseRef);
  const fallbackMode = newDirs === null;
  const targetDirs = fallbackMode ? fs.readdirSync(MIGRATIONS_DIR).filter((d) => fs.statSync(path.join(MIGRATIONS_DIR, d)).isDirectory()) : newDirs;

  if (fallbackMode) {
    console.log(`Could not resolve base ref "${baseRef}" (git unavailable, shallow clone, or no such ref) — scanning ALL ${targetDirs.length} migrations informationally. This mode never fails the build.\n`);
  } else {
    console.log(`Comparing against "${baseRef}" — ${targetDirs.length} newly added migration(s) found.\n`);
  }

  let hardFailure = false;
  let flaggedCount = 0;

  for (const dir of targetDirs) {
    const result = scanMigrationFile(dir);
    if (!result || result.findings.length === 0) continue;
    flaggedCount++;
    if (result.acknowledged) {
      console.log(`  [ACKNOWLEDGED] ${dir}: ${result.findings.join(", ")} — reason: "${result.reason}"`);
    } else if (fallbackMode) {
      console.log(`  [INFO, historical] ${dir}: ${result.findings.join(", ")} — not required to acknowledge (informational fallback mode, not a newly added migration in this diff)`);
    } else {
      console.log(`  [UNACKNOWLEDGED — FAIL] ${dir}: ${result.findings.join(", ")}`);
      console.log(`      This is a NEWLY ADDED migration in this diff with a potentially destructive statement and no explicit acknowledgement.`);
      console.log(`      If this is intentional, add a line to migration.sql: -- ALLOW-DESTRUCTIVE: <why this is safe, e.g. "column added and never released in a prior deploy">`);
      hardFailure = true;
    }
  }

  if (flaggedCount === 0) {
    console.log(fallbackMode ? "No destructive statements found in any migration." : "No destructive statements found in any newly added migration.");
  }

  console.log(`\n=== Summary: ${targetDirs.length} migration(s) scanned, ${flaggedCount} flagged ===`);

  if (hardFailure) {
    console.log("FAIL — see UNACKNOWLEDGED items above. This does not mean the migration is wrong — only that it must be explicitly, auditably acknowledged before it can ship.");
    process.exitCode = 1;
    return;
  }
  console.log("PASS.");
  process.exitCode = 0;
}

module.exports = { scanSql, findUnwhereDeletes };

if (require.main === module) {
  main();
}
