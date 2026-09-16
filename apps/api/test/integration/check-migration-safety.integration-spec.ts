/**
 * Phase 29 — tests for check-migration-safety.js's pure scanSql()
 * function, using in-memory SQL strings only — no database, no
 * subprocess, no filesystem/git access needed (scanSql() takes text
 * directly). Placed alongside the other integration specs (following
 * guard-destructive-migration.integration-spec.ts's own precedent for
 * "a scripts/ tool's test belongs here even when it needs no
 * database") purely for consistency of location, not because this
 * suite actually needs the real Postgres instance the integration
 * harness provisions. The CLI-level behavior (git diff resolution,
 * fallback mode, exit codes) is exercised for real by running the
 * script against this repository's own history in CI's
 * `check:migration-safety` step, not re-tested here.
 */
const { scanSql, findUnwhereDeletes } = require("../../scripts/check-migration-safety.js");

describe("check-migration-safety.js scanSql()", () => {
  it("finds nothing in an ordinary additive migration", () => {
    const result = scanSql(`ALTER TABLE "User" ADD COLUMN "nickname" TEXT;`);
    expect(result.findings).toEqual([]);
  });

  it("flags DROP TABLE", () => {
    const result = scanSql(`DROP TABLE "OldThing";`);
    expect(result.findings).toContain("DROP TABLE");
    expect(result.acknowledged).toBe(false);
  });

  it("flags DROP COLUMN", () => {
    const result = scanSql(`ALTER TABLE "User" DROP COLUMN "legacyField";`);
    expect(result.findings).toContain("DROP COLUMN");
  });

  it("flags TRUNCATE", () => {
    const result = scanSql(`TRUNCATE "AuditLog";`);
    expect(result.findings).toContain("TRUNCATE");
  });

  it("flags a DELETE FROM with no WHERE clause", () => {
    const result = scanSql(`DELETE FROM "Session";`);
    expect(result.findings.some((f: string) => f.startsWith("DELETE FROM without WHERE"))).toBe(true);
  });

  it("does NOT flag a DELETE FROM that has a WHERE clause", () => {
    const result = scanSql(`DELETE FROM "Session" WHERE "expiresAt" < now();`);
    expect(result.findings).toEqual([]);
  });

  it("is case-insensitive", () => {
    const result = scanSql(`drop table "OldThing";`);
    expect(result.findings).toContain("DROP TABLE");
  });

  it("recognizes an ALLOW-DESTRUCTIVE acknowledgement and captures its reason", () => {
    const result = scanSql(`
      -- ALLOW-DESTRUCTIVE: column was added and never released in a prior deploy
      ALTER TABLE "User" DROP COLUMN "neverShipped";
    `);
    expect(result.findings).toContain("DROP COLUMN");
    expect(result.acknowledged).toBe(true);
    expect(result.reason).toBe("column was added and never released in a prior deploy");
  });

  it("does not treat a bare '-- ALLOW-DESTRUCTIVE:' with no reason as acknowledged", () => {
    const result = scanSql(`
      -- ALLOW-DESTRUCTIVE:
      DROP TABLE "OldThing";
    `);
    expect(result.acknowledged).toBe(false);
  });

  it("flags multiple distinct dangerous statements in one migration", () => {
    const result = scanSql(`
      DROP TABLE "A";
      TRUNCATE "B";
      DELETE FROM "C";
    `);
    expect(result.findings).toContain("DROP TABLE");
    expect(result.findings).toContain("TRUNCATE");
    expect(result.findings.some((f: string) => f.startsWith("DELETE FROM without WHERE"))).toBe(true);
  });
});

describe("check-migration-safety.js findUnwhereDeletes()", () => {
  it("returns each unwhere'd DELETE statement, trimmed", () => {
    const found = findUnwhereDeletes(`DELETE FROM "A"; DELETE FROM "B" WHERE id = 1; DELETE FROM "C";`);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^DELETE FROM "A"/);
    expect(found[1]).toMatch(/^DELETE FROM "C"/);
  });

  it("returns an empty array when every DELETE has a WHERE", () => {
    expect(findUnwhereDeletes(`DELETE FROM "A" WHERE id = 1;`)).toEqual([]);
  });

  it("returns an empty array when there is no DELETE at all", () => {
    expect(findUnwhereDeletes(`ALTER TABLE "A" ADD COLUMN "x" TEXT;`)).toEqual([]);
  });
});
