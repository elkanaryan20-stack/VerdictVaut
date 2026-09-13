import { ForbiddenException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthService } from "../../src/auth/auth.service";
import { UsersService } from "../../src/users/users.service";
import { auditLog, createTestMarket, createTestSuperAdmin, fundUserForTest, openMarketForTest, ordersService, prisma } from "./helpers";

// Key-aware, unlike login-throttle.integration-spec.ts's own config mock
// — register()/verifyEmail() also read "nodeEnv" (Phase 18 remediation)
// to decide whether to include devVerificationToken.
function makeAuthService(nodeEnv: string = "test") {
  const config = {
    get: (key: string) => (key === "nodeEnv" ? nodeEnv : { accessSecret: "test-access-secret", refreshSecret: "test-refresh-secret", accessTtl: "15m", refreshTtl: "7d" }),
  };
  return new AuthService(prisma, new JwtService(), config as never, auditLog);
}

const usersService = new UsersService(prisma);

/**
 * Phase 18 remediation — proves the complete, REAL lifecycle end to end
 * against real Postgres, through the actual AuthService.register() and
 * AuthService.verifyEmail() code paths (never a fixture-created ACTIVE
 * user — see createTestUser's own default in helpers.ts, which is
 * exactly what let the original bug go unnoticed for 17 phases).
 */
describe("User activation lifecycle (real Postgres, real registration flow)", () => {
  it("registration -> PENDING_VERIFICATION -> verifyEmail -> ACTIVE -> can use a permitted (status-gated) feature", async () => {
    const authService = makeAuthService();
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `lifecycle-${marker}@example.test`;

    const registerResult = await authService.register({ email, password: "a-real-password-123" });

    const afterRegister = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(afterRegister.status).toBe("PENDING_VERIFICATION");
    expect(afterRegister.emailVerificationTokenHash).toEqual(expect.any(String));
    expect(registerResult.devVerificationToken).toEqual(expect.any(String));

    // The status-sensitive feature must be genuinely blocked BEFORE
    // verification — the intended production policy this phase must not
    // accidentally broaden.
    const admin = await createTestSuperAdmin();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);

    await expect(
      ordersService.create(afterRegister.id, { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "1", price: "0.5" }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      ordersService.create(afterRegister.id, { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "1", price: "0.5" }),
    ).rejects.toThrow(/must be verified/);

    // The real, legitimate activation path.
    const verifyResult = await authService.verifyEmail(registerResult.devVerificationToken!);
    expect(verifyResult.status).toBe("ACTIVE");

    const afterVerify = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(afterVerify.status).toBe("ACTIVE");
    expect(afterVerify.emailVerifiedAt).not.toBeNull();
    expect(afterVerify.emailVerificationTokenHash).toBeNull(); // single-use — cleared on success
    expect(afterVerify.emailVerificationTokenExpiresAt).toBeNull();

    // Now a genuinely permitted feature actually works — funded via the
    // same sanctioned test-fixture helper every other integration test
    // in this suite already uses (not a real/fabricated blockchain
    // deposit; see fundUserForTest's own docblock).
    await fundUserForTest(afterVerify.id, "USDC", "100");
    const order = await ordersService.create(afterVerify.id, {
      marketId: market.id,
      outcomeId: yes.id,
      side: "BUY",
      type: "LIMIT",
      quantity: "10",
      price: "0.5",
    });
    expect(order.status).toBe("OPEN");
  });

  it("verifyEmail rejects an unknown/wrong token", async () => {
    const authService = makeAuthService();
    await expect(authService.verifyEmail("a-token-that-was-never-issued-to-anyone")).rejects.toThrow(/Invalid or expired/);
  });

  it("verifyEmail rejects re-submission of an already-consumed token (single-use)", async () => {
    const authService = makeAuthService();
    const marker = `${Date.now()}-${Math.random()}`;
    const { devVerificationToken } = await authService.register({ email: `reuse-${marker}@example.test`, password: "a-real-password-123" });

    await authService.verifyEmail(devVerificationToken!);
    await expect(authService.verifyEmail(devVerificationToken!)).rejects.toThrow(/Invalid or expired/);
  });

  it("two CONCURRENT verifyEmail submissions of the identical valid token activate the account exactly once", async () => {
    const authService = makeAuthService();
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `concurrent-verify-${marker}@example.test`;
    const { devVerificationToken } = await authService.register({ email, password: "a-real-password-123" });

    const results = await Promise.allSettled([authService.verifyEmail(devVerificationToken!), authService.verifyEmail(devVerificationToken!)]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.status).toBe("ACTIVE");
  });

  it("devVerificationToken is NEVER present when nodeEnv is production", async () => {
    const authService = makeAuthService("production");
    const marker = `${Date.now()}-${Math.random()}`;
    const result = await authService.register({ email: `prod-${marker}@example.test`, password: "a-real-password-123" });
    expect(result).not.toHaveProperty("devVerificationToken");

    // The user is still PENDING_VERIFICATION — production not receiving
    // the token doesn't mean production silently skips verification, it
    // means production genuinely has no self-service channel to deliver
    // it yet (see AuthService.register's own docblock) — the admin path
    // below is what remains available in that case.
    const user = await prisma.user.findUniqueOrThrow({ where: { email: `prod-${marker}@example.test` } });
    expect(user.status).toBe("PENDING_VERIFICATION");
  });

  describe("SUPER_ADMIN activation path (UsersService.adminActivate)", () => {
    it("activates a real, registration-flow-created PENDING_VERIFICATION user, distinct provenance from self-verification (emailVerifiedAt stays null)", async () => {
      const authService = makeAuthService();
      const marker = `${Date.now()}-${Math.random()}`;
      const email = `admin-activate-${marker}@example.test`;
      await authService.register({ email, password: "a-real-password-123" });
      const created = await prisma.user.findUniqueOrThrow({ where: { email } });

      const result = await usersService.adminActivate(created.id);
      expect(result).toEqual({ id: created.id, status: "ACTIVE", changed: true });

      const updated = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
      expect(updated.status).toBe("ACTIVE");
      expect(updated.emailVerifiedAt).toBeNull(); // admin override, not real email verification
    });

    it("is idempotent — a second call on the same now-ACTIVE user is a safe no-op", async () => {
      const authService = makeAuthService();
      const marker = `${Date.now()}-${Math.random()}`;
      const email = `admin-idempotent-${marker}@example.test`;
      await authService.register({ email, password: "a-real-password-123" });
      const created = await prisma.user.findUniqueOrThrow({ where: { email } });

      const first = await usersService.adminActivate(created.id);
      const second = await usersService.adminActivate(created.id);

      expect(first.changed).toBe(true);
      expect(second).toEqual({ id: created.id, status: "ACTIVE", changed: false });
    });

    it("never reactivates a SUSPENDED user", async () => {
      const authService = makeAuthService();
      const marker = `${Date.now()}-${Math.random()}`;
      const email = `admin-suspended-${marker}@example.test`;
      await authService.register({ email, password: "a-real-password-123" });
      const created = await prisma.user.findUniqueOrThrow({ where: { email } });
      await prisma.user.update({ where: { id: created.id }, data: { status: "SUSPENDED" } });

      const result = await usersService.adminActivate(created.id);
      expect(result).toEqual({ id: created.id, status: "SUSPENDED", changed: false });

      const stillSuspended = await prisma.user.findUniqueOrThrow({ where: { id: created.id } });
      expect(stillSuspended.status).toBe("SUSPENDED");
    });
  });
});
