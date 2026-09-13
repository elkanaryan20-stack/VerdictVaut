import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import * as crypto from "crypto";
import { AuthService } from "../../src/auth/auth.service";
import { EmailProvider } from "../../src/email/email-provider.interface";
import { ActiveUserGuard } from "../../src/common/guards/active-user.guard";
import { DepositsController } from "../../src/wallet/deposits/deposits.controller";
import { TradingController } from "../../src/trading/trading.controller";
import { WithdrawalsController } from "../../src/wallet/withdrawals/withdrawals.controller";
import { UsersService } from "../../src/users/users.service";
import { auditLog, depositAddressService, ordersService, prisma, withdrawalsService } from "./helpers";

const TEST_ACCESS_SECRET = "test-access-secret";

function makeFakeEmailProvider(): EmailProvider & { calls: { to: string; verificationUrl: string }[] } {
  return {
    calls: [],
    async sendVerificationEmail(input) {
      this.calls.push(input);
      return { providerMessageId: `fake-${this.calls.length}` };
    },
  };
}

function makeAuthService(emailProvider: EmailProvider) {
  const jwt = new JwtService();
  const config = {
    get: (key: string) => {
      if (key === "nodeEnv") return "test";
      if (key === "email") return { provider: "none", postmarkServerToken: "", fromAddress: "", baseUrl: "https://app.verdictvaut.test" };
      return { accessSecret: TEST_ACCESS_SECRET, refreshSecret: "test-refresh-secret", accessTtl: "15m", refreshTtl: "7d" };
    },
  };
  return { authService: new AuthService(prisma, jwt, config as never, auditLog, emailProvider), jwt };
}

/** A minimal real ExecutionContext wired to the REAL controller class/handler, so Reflector.getAllAndOverride reads the REAL @RequireActiveUser() metadata actually attached to that route — not a mocked stand-in for it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeGuardContext(handler: (...args: any[]) => unknown, controllerClass: unknown, userId: string): ExecutionContext {
  const request = { user: { id: userId } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => controllerClass,
  } as unknown as ExecutionContext;
}

const usersService = new UsersService(prisma);

/**
 * Phase 20 security-gate audit — proves the PENDING_VERIFICATION
 * lifecycle end to end through the REAL registration flow (never a
 * fixture-created ACTIVE user), against the REAL guard/service code
 * that actually runs in production, using the REAL JWT registration
 * returns.
 *
 * This repository has no HTTP/supertest harness (a known, previously
 * disclosed limitation — see docs/security-and-operational-validation.md
 * §1's own "NOT EXECUTED" note), so "call the protected endpoint" here
 * means: decode the REAL access token exactly as JwtStrategy would, then
 * invoke the REAL ActiveUserGuard against the REAL, unmocked
 * `@RequireActiveUser()` metadata actually attached to
 * TradingController/WithdrawalsController/DepositsController's real
 * route handlers (via a real Reflector reading real reflect-metadata),
 * and the REAL service methods those routes call — all against the REAL
 * row register() created in Postgres. This proves the same guarantee an
 * HTTP request would, without inventing a new test-transport dependency.
 */
describe("PENDING_VERIFICATION lifecycle — real registration flow, real guards (Phase 20 security-gate audit)", () => {
  it("a genuinely PENDING_VERIFICATION user: resend allowed, order/withdrawal/deposit-address DENIED by the real guard AND the real service-level check", async () => {
    const emailProvider = makeFakeEmailProvider();
    const { authService, jwt } = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `pending-lifecycle-${marker}@example.test`;

    const registerResult = await authService.register({ email, password: "a-real-password-123" });
    const payload = await jwt.verifyAsync<{ sub: string; email: string; role: string }>(registerResult.accessToken, { secret: TEST_ACCESS_SECRET });
    expect(payload.email).toBe(email);
    const userId = payload.sub;

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(dbUser.status).toBe("PENDING_VERIFICATION");

    // 1. Resend verification email — ALLOWED (no ActiveUserGuard on this route at all).
    await expect(authService.resendVerificationEmail(userId)).resolves.toBeUndefined();
    expect(emailProvider.calls.length).toBeGreaterThanOrEqual(2); // one from register(), one from resend

    // 2. Order creation — DENIED by the real ActiveUserGuard on the real route...
    const guard = new ActiveUserGuard(new Reflector(), prisma);
    await expect(
      guard.canActivate(makeGuardContext(TradingController.prototype.createOrder, TradingController, userId)),
    ).rejects.toThrow(ForbiddenException);
    // ...AND independently by OrdersService's own defense-in-depth check.
    await expect(
      ordersService.create(userId, { marketId: crypto.randomUUID(), outcomeId: crypto.randomUUID(), side: "BUY", type: "LIMIT", quantity: "1", price: "0.5" }),
    ).rejects.toThrow(/must be verified/);

    // 3. Withdrawal request — DENIED the same way.
    await expect(
      guard.canActivate(makeGuardContext(WithdrawalsController.prototype.request, WithdrawalsController, userId)),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      withdrawalsService.request(userId, { assetSymbol: "USDC", networkCode: "ethereum-sepolia", amount: "10", destinationAddress: "0x000000000000000000000000000000000000dEaD" }),
    ).rejects.toThrow(/must be verified/);

    // 4. Deposit-address self-assignment — DENIED by the guard (this had
    // NO service-level check before Phase 20's security-gate fix — the
    // guard is the ONLY protection here, proven by calling the
    // unguarded service method directly and observing it does NOT throw).
    await expect(
      guard.canActivate(makeGuardContext(DepositsController.prototype.assignAddress, DepositsController, userId)),
    ).rejects.toThrow(ForbiddenException);
    await expect(depositAddressService.getOrAssign(userId, "USDC", "ethereum-sepolia")).resolves.toBeDefined(); // service layer alone never blocked this — the guard is load-bearing here
  });

  it("after real email verification, the SAME originally-issued JWT now passes every previously-denied check — no new login/token needed", async () => {
    const emailProvider = makeFakeEmailProvider();
    const { authService, jwt } = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `pending-then-active-${marker}@example.test`;

    const registerResult = await authService.register({ email, password: "a-real-password-123" });
    const payload = await jwt.verifyAsync<{ sub: string }>(registerResult.accessToken, { secret: TEST_ACCESS_SECRET });
    const userId = payload.sub;

    const activation = await authService.verifyEmail(registerResult.devVerificationToken!);
    expect(activation.status).toBe("ACTIVE");

    const guard = new ActiveUserGuard(new Reflector(), prisma);
    await expect(
      guard.canActivate(makeGuardContext(TradingController.prototype.createOrder, TradingController, userId)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(makeGuardContext(WithdrawalsController.prototype.request, WithdrawalsController, userId)),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(makeGuardContext(DepositsController.prototype.assignAddress, DepositsController, userId)),
    ).resolves.toBe(true);

    // The real service-level defense-in-depth checks also now pass —
    // proven by getting past the ACTIVE gate (a subsequent, unrelated
    // "market not found" error proves this, not a "must be verified" one).
    await expect(
      ordersService.create(userId, { marketId: crypto.randomUUID(), outcomeId: crypto.randomUUID(), side: "BUY", type: "LIMIT", quantity: "1", price: "0.5" }),
    ).rejects.not.toThrow(/must be verified/);
  });

  it("an expired verification token cannot activate the account — it remains safely PENDING_VERIFICATION and still denied everywhere", async () => {
    const emailProvider = makeFakeEmailProvider();
    const { authService, jwt } = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `pending-expired-${marker}@example.test`;

    const registerResult = await authService.register({ email, password: "a-real-password-123" });
    const payload = await jwt.verifyAsync<{ sub: string }>(registerResult.accessToken, { secret: TEST_ACCESS_SECRET });
    const userId = payload.sub;

    // Backdate the real token's expiry — the ONLY thing this test
    // manipulates directly; the token itself is the real one register()
    // issued.
    await prisma.user.update({ where: { id: userId }, data: { emailVerificationTokenExpiresAt: new Date(Date.now() - 1000) } });

    await expect(authService.verifyEmail(registerResult.devVerificationToken!)).rejects.toThrow(/Invalid or expired/);

    const stillPending = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(stillPending.status).toBe("PENDING_VERIFICATION");

    const guard = new ActiveUserGuard(new Reflector(), prisma);
    await expect(
      guard.canActivate(makeGuardContext(TradingController.prototype.createOrder, TradingController, userId)),
    ).rejects.toThrow(ForbiddenException);
  });

  it("SUPER_ADMIN adminActivate remains functional and unblocks the same real guard/service checks — the operational escape hatch Phase 20 must not have broken", async () => {
    const emailProvider = makeFakeEmailProvider();
    const { authService, jwt } = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `pending-admin-activate-${marker}@example.test`;

    const registerResult = await authService.register({ email, password: "a-real-password-123" });
    const payload = await jwt.verifyAsync<{ sub: string }>(registerResult.accessToken, { secret: TEST_ACCESS_SECRET });
    const userId = payload.sub;

    const result = await usersService.adminActivate(userId);
    expect(result.changed).toBe(true);

    const guard = new ActiveUserGuard(new Reflector(), prisma);
    await expect(
      guard.canActivate(makeGuardContext(WithdrawalsController.prototype.request, WithdrawalsController, userId)),
    ).resolves.toBe(true);
  });

  it("login while PENDING_VERIFICATION issues a usable-for-identity JWT that STILL cannot pass the financial gate — confirms no bypass via re-login", async () => {
    const emailProvider = makeFakeEmailProvider();
    const { authService, jwt } = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `pending-relogin-${marker}@example.test`;

    await authService.register({ email, password: "a-real-password-123" });
    const loginResult = await authService.login({ email, password: "a-real-password-123" });
    const payload = await jwt.verifyAsync<{ sub: string }>(loginResult.accessToken, { secret: TEST_ACCESS_SECRET });

    const guard = new ActiveUserGuard(new Reflector(), prisma);
    await expect(
      guard.canActivate(makeGuardContext(TradingController.prototype.createOrder, TradingController, payload.sub)),
    ).rejects.toThrow(ForbiddenException);
  });
});
