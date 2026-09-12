import { spawnSync } from "child_process";
import * as path from "path";

const SCRIPT_PATH = path.join(__dirname, "..", "..", "scripts", "guard-destructive-migration.js");

/**
 * Phase 17 — apps/api/scripts/guard-destructive-migration.js (Phase 16)
 * was previously only manually exercised via ad-hoc shell commands, never
 * covered by an automated test. Runs the REAL script as a real child
 * process (it always calls process.exit() at its top level — requiring
 * it directly would kill the Jest worker) with controlled environment
 * variables, and asserts its exit code / refusal message. Never touches
 * any database, never actually runs a Prisma command — this only proves
 * the guard's own env-var decision, exactly the boundary it owns.
 *
 * Placed alongside the other real-Postgres integration specs (though it
 * needs no database itself) because it belongs to the same "Database &
 * migrations" concern this test suite groups together, and because the
 * jest-integration config's rootDir already resolves scripts/ correctly
 * relative to this file.
 */
function runGuard(env: Record<string, string | undefined>) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: path.join(__dirname, "..", ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

describe("guard-destructive-migration.js (real child process, no database)", () => {
  it("allows (exit 0) when neither APP_ENVIRONMENT nor NODE_ENV is production", () => {
    const { status } = runGuard({ APP_ENVIRONMENT: "sandbox", NODE_ENV: "development" });
    expect(status).toBe(0);
  });

  it("allows (exit 0) when both are entirely unset", () => {
    const { status } = runGuard({ APP_ENVIRONMENT: undefined, NODE_ENV: undefined });
    expect(status).toBe(0);
  });

  it("refuses (exit 1) with a clear message when APP_ENVIRONMENT=production", () => {
    const { status, stderr } = runGuard({ APP_ENVIRONMENT: "production", NODE_ENV: "development" });
    expect(status).toBe(1);
    expect(stderr).toMatch(/REFUSING to run/);
    expect(stderr).toMatch(/prisma:migrate:deploy/);
  });

  it("refuses (exit 1) when NODE_ENV=production, even if APP_ENVIRONMENT is sandbox", () => {
    const { status, stderr } = runGuard({ APP_ENVIRONMENT: "sandbox", NODE_ENV: "production" });
    expect(status).toBe(1);
    expect(stderr).toMatch(/REFUSING to run/);
  });

  it("refuses regardless of casing (APP_ENVIRONMENT=PRODUCTION)", () => {
    const { status } = runGuard({ APP_ENVIRONMENT: "PRODUCTION", NODE_ENV: "development" });
    expect(status).toBe(1);
  });

  // Phase 17 review finding M3's documented limitation, proven as a
  // living regression test rather than only prose: the guard's decision
  // is driven entirely by APP_ENVIRONMENT/NODE_ENV's NAMES, never by
  // DATABASE_URL's actual value. A DATABASE_URL that looks exactly like
  // a real production connection string does NOT, on its own, cause a
  // refusal — see docs/production-database-requirements.md §4 for why
  // this is a deliberate scope boundary, not a bug this test is meant to
  // "catch": if this test ever starts FAILING (i.e. the guard starts
  // refusing here), that's a deliberate behavior change to notice and
  // re-document, not a regression to silently accept.
  it("documents the known limitation: a production-looking DATABASE_URL alone does not trigger a refusal", () => {
    const { status } = runGuard({
      APP_ENVIRONMENT: "sandbox",
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://prod_user:prod_pass@prod-db.internal.example.com:5432/verdictvaut_production?sslmode=require",
    });
    expect(status).toBe(0);
  });
});
