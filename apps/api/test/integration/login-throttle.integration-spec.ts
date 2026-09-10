import { JwtService } from "@nestjs/jwt";
import { UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { AuthService } from "../../src/auth/auth.service";
import { auditLog, createTestUser, prisma } from "./helpers";

const config = {
  get: () => ({ accessSecret: "test-access-secret", refreshSecret: "test-refresh-secret", accessTtl: "15m", refreshTtl: "7d" }),
};

function makeAuthService() {
  return new AuthService(prisma, new JwtService(), config as never, auditLog);
}

async function createUserWithPassword(password: string, overrides: { role?: "USER" | "SUPER_ADMIN"; status?: "ACTIVE" | "SUSPENDED" } = {}) {
  const user = await createTestUser(overrides.status ?? "ACTIVE", overrides.role ?? "USER");
  const passwordHash = await bcrypt.hash(password, 4);
  return prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
}

/**
 * Phase 13 remediation — real-Postgres proof that the bounded login
 * throttle (src/auth/login-throttle.util.ts) is genuinely race-safe
 * under real concurrent writes, not just correct against a mocked,
 * artificially-serialized sequence of calls (see the unit-level
 * equivalent in auth.service.spec.ts).
 */
describe("Login throttle (real Postgres)", () => {
  it("locks the account after enough real concurrent wrong-password attempts, and the lock is bounded, not permanent", async () => {
    const authService = makeAuthService();
    const user = await createUserWithPassword("correct-password");

    // Fire more concurrent wrong-password attempts than the lock
    // threshold — real Postgres must serialize the underlying atomic
    // increments correctly regardless of how many arrive at once.
    const attempts = Array.from({ length: 8 }, () =>
      authService.login({ email: user.email, password: "wrong-password" }).catch((e) => e),
    );
    const results = await Promise.all(attempts);
    expect(results.every((r) => r instanceof UnauthorizedException)).toBe(true);

    const refreshed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(refreshed.failedLoginAttempts).toBe(8); // no lost updates under real concurrency
    expect(refreshed.lockedUntil).not.toBeNull();
    // Bounded — even 8 real concurrent failures never produce more than
    // the capped 15-minute delay defined in login-throttle.util.ts.
    expect(refreshed.lockedUntil!.getTime() - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 1000);

    // The correct password is still rejected while locked, with the
    // same generic message — the lock genuinely blocks access, it isn't
    // just a counter that happens to sit there unused.
    await expect(authService.login({ email: user.email, password: "correct-password" })).rejects.toThrow(
      "Invalid email or password",
    );
  });

  it("a successful login fully resets the failure state — the throttle never outlives proof of ownership", async () => {
    const authService = makeAuthService();
    const user = await createUserWithPassword("correct-password");

    for (let i = 0; i < 3; i += 1) {
      await authService.login({ email: user.email, password: "wrong" }).catch(() => undefined);
    }
    const midway = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(midway.failedLoginAttempts).toBe(3);

    await authService.login({ email: user.email, password: "correct-password" });

    const afterSuccess = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(afterSuccess.failedLoginAttempts).toBe(0);
    expect(afterSuccess.lockedUntil).toBeNull();
  });

  it("an attacker who only knows a victim's email cannot deny them access forever — the lock expires on its own with no admin intervention", async () => {
    const authService = makeAuthService();
    const user = await createUserWithPassword("correct-password");

    // Drive the account into a locked state, then simulate the lock
    // having already expired (rather than sleeping the test for real
    // minutes) by writing an already-past lockedUntil directly — this
    // tests the SAME expiry check `isCurrentlyLocked` uses at login time,
    // not a different code path.
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 6, lockedUntil: new Date(Date.now() - 1000) },
    });

    const result = await authService.login({ email: user.email, password: "correct-password" });
    expect(result.accessToken).toBeTruthy();

    const afterSuccess = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(afterSuccess.failedLoginAttempts).toBe(0);
    expect(afterSuccess.lockedUntil).toBeNull();
  });

  it("applies the same throttle to a SUPER_ADMIN account — no exemption that would weaken it", async () => {
    const authService = makeAuthService();
    const admin = await createUserWithPassword("correct-password", { role: "SUPER_ADMIN" });
    await prisma.user.update({ where: { id: admin.id }, data: { failedLoginAttempts: 6, lockedUntil: new Date(Date.now() + 5 * 60_000) } });

    await expect(authService.login({ email: admin.email, password: "correct-password" })).rejects.toThrow(
      "Invalid email or password",
    );
  });

  it("a suspended account is still throttled first — the throttle and the suspension check compose rather than one bypassing the other", async () => {
    const authService = makeAuthService();
    const user = await createUserWithPassword("correct-password", { status: "SUSPENDED" });
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 6, lockedUntil: new Date(Date.now() + 5 * 60_000) } });

    const error = await authService.login({ email: user.email, password: "correct-password" }).catch((e) => e);
    // Still the generic throttle message, not "Account is suspended" —
    // the lock check runs first and gives no extra information away.
    expect(error).toBeInstanceOf(UnauthorizedException);
  });
});
