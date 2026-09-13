import { spawnSync } from "child_process";
import * as path from "path";
import { prisma } from "./helpers";

const SCRIPT_PATH = path.join(__dirname, "..", "..", "scripts", "bootstrap-super-admin.js");
const API_DIR = path.join(__dirname, "..", "..");

function runBootstrap(env: Record<string, string | undefined>) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function registerRawUser(email: string, status: "PENDING_VERIFICATION" | "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  return prisma.user.create({ data: { email, passwordHash: "not-a-real-hash-for-this-test", status } });
}

// Test-fixture-only setup helper — deliberately bypasses the script
// entirely (a direct Prisma write, not spawning bootstrap-super-admin.js)
// so tests can establish "at least one super-admin already exists" as a
// precondition WITHOUT that setup step itself being subject to the
// script's own gating logic, which is what several tests below are
// actually trying to exercise on a SEPARATE, subsequent real script
// invocation.
async function seedExistingSuperAdmin() {
  const email = `precondition-super-admin-${Date.now()}-${Math.random()}@example.test`;
  return prisma.user.create({ data: { email, passwordHash: "unused", status: "ACTIVE", role: "SUPER_ADMIN" } });
}

/**
 * Phase 18 remediation — runs the REAL script as a real child process
 * (it always calls process.exit()) against real Postgres, proving the
 * "impossible to rerun to elevate another account unintentionally" and
 * "unauthorized/repeated bootstrap attempts" requirements for real, not
 * just by reading the source.
 *
 * This shared integration-test database is NOT guaranteed super-admin-
 * free by the time this file runs — createTestSuperAdmin() (helpers.ts)
 * is used directly by many other integration test files sharing this
 * same database within one test run. Every test below is written to be
 * correct regardless of that prior state (never assuming "this is the
 * very first super-admin ever created") — see seedExistingSuperAdmin's
 * own docblock for how "at least one already exists" preconditions are
 * established deterministically.
 */
describe("bootstrap-super-admin.js (real child process, real Postgres)", () => {
  it("refuses when BOOTSTRAP_SUPER_ADMIN_EMAIL is not set", () => {
    const { status, stderr } = runBootstrap({ BOOTSTRAP_SUPER_ADMIN_EMAIL: undefined });
    expect(status).toBe(1);
    expect(stderr).toMatch(/BOOTSTRAP_SUPER_ADMIN_EMAIL is not set/);
  });

  it("refuses when the target email has never registered", () => {
    const { status, stderr } = runBootstrap({ BOOTSTRAP_SUPER_ADMIN_EMAIL: `never-registered-${Date.now()}@example.test` });
    expect(status).toBe(1);
    expect(stderr).toMatch(/no user found/);
  });

  it("bootstraps a real, previously-registered user to SUPER_ADMIN and ACTIVE, and writes an audit log entry", async () => {
    const email = `bootstrap-fresh-${Date.now()}-${Math.random()}@example.test`;
    const user = await registerRawUser(email, "PENDING_VERIFICATION");

    const { status, stdout } = runBootstrap({ BOOTSTRAP_SUPER_ADMIN_EMAIL: email, BOOTSTRAP_ALLOW_ADDITIONAL_SUPER_ADMIN: "true" });
    expect(status).toBe(0);
    expect(stdout).toMatch(/Bootstrapped SUPER_ADMIN/);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.role).toBe("SUPER_ADMIN");
    expect(updated.status).toBe("ACTIVE"); // was stuck PENDING_VERIFICATION — bootstrap must leave a genuinely usable admin

    const audit = await prisma.auditLog.findFirst({ where: { resourceType: "User", resourceId: user.id, action: "user.super_admin_bootstrap" } });
    expect(audit).not.toBeNull();
    expect(audit!.actorType).toBe("SYSTEM");
  });

  it("is idempotent: re-running with the SAME email is a safe no-op (exit 0, no duplicate audit entry)", async () => {
    const email = `bootstrap-idempotent-${Date.now()}-${Math.random()}@example.test`;
    const user = await registerRawUser(email, "ACTIVE");

    const first = runBootstrap({ BOOTSTRAP_SUPER_ADMIN_EMAIL: email, BOOTSTRAP_ALLOW_ADDITIONAL_SUPER_ADMIN: "true" });
    expect(first.status).toBe(0);
    // The second call needs no override flag: by now THIS email is
    // already SUPER_ADMIN, which the script checks before the "how many
    // OTHER super-admins exist" gate.
    const second = runBootstrap({ BOOTSTRAP_SUPER_ADMIN_EMAIL: email });
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/Already SUPER_ADMIN/);

    const auditCount = await prisma.auditLog.count({ where: { resourceType: "User", resourceId: user.id, action: "user.super_admin_bootstrap" } });
    expect(auditCount).toBe(1); // only the FIRST run actually wrote anything
  });

  it("refuses to elevate a DIFFERENT account once a super-admin already exists, by default", async () => {
    await seedExistingSuperAdmin();
    const secondEmail = `bootstrap-second-${Date.now()}-${Math.random()}@example.test`;
    const secondUser = await registerRawUser(secondEmail, "ACTIVE");

    const result = runBootstrap({ BOOTSTRAP_SUPER_ADMIN_EMAIL: secondEmail });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exist/);
    expect(result.stderr).toMatch(/BOOTSTRAP_ALLOW_ADDITIONAL_SUPER_ADMIN/);

    const stillNotAdmin = await prisma.user.findUniqueOrThrow({ where: { id: secondUser.id } });
    expect(stillNotAdmin.role).toBe("USER");
  });

  it("allows a second super-admin only with the explicit override flag", async () => {
    await seedExistingSuperAdmin();
    const email = `bootstrap-override-${Date.now()}-${Math.random()}@example.test`;
    const user = await registerRawUser(email, "ACTIVE");

    const result = runBootstrap({ BOOTSTRAP_SUPER_ADMIN_EMAIL: email, BOOTSTRAP_ALLOW_ADDITIONAL_SUPER_ADMIN: "true" });
    expect(result.status).toBe(0);

    const nowAdmin = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(nowAdmin.role).toBe("SUPER_ADMIN");
  });

  it("refuses to touch a SUSPENDED account, even with the override flag set", async () => {
    const email = `bootstrap-suspended-${Date.now()}-${Math.random()}@example.test`;
    const user = await registerRawUser(email, "SUSPENDED");

    const { status, stderr } = runBootstrap({ BOOTSTRAP_SUPER_ADMIN_EMAIL: email, BOOTSTRAP_ALLOW_ADDITIONAL_SUPER_ADMIN: "true" });
    expect(status).toBe(1);
    expect(stderr).toMatch(/SUSPENDED/);

    const stillSuspended = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillSuspended.role).toBe("USER");
    expect(stillSuspended.status).toBe("SUSPENDED");
  });
});
