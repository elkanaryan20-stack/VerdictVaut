import { JwtService } from "@nestjs/jwt";
import * as crypto from "crypto";
import { AuthService } from "../../src/auth/auth.service";
import { EmailProvider } from "../../src/email/email-provider.interface";
import { auditLog, prisma } from "./helpers";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Real Postgres, real AuthService.register()/resendVerificationEmail()
 * code paths — same methodology as user-activation.integration-spec.ts.
 * No real Postmark call is ever made: every test injects a fake
 * EmailProvider (a plain jest-free recorder, since this file has no
 * jest.fn() dependency the way unit-test spec files do) so behavior is
 * asserted directly against real DB state, not a mocked HTTP boundary.
 */
function makeFakeEmailProvider(): EmailProvider & { calls: { to: string; verificationUrl: string }[]; shouldFail: boolean } {
  return {
    calls: [],
    shouldFail: false,
    async sendVerificationEmail(input) {
      this.calls.push(input);
      if (this.shouldFail) throw new Error("simulated provider failure");
      return { providerMessageId: `fake-${this.calls.length}` };
    },
  };
}

function makeAuthService(emailProvider: EmailProvider) {
  const config = {
    get: (key: string) => {
      if (key === "nodeEnv") return "test";
      if (key === "email") return { provider: "none", postmarkServerToken: "", fromAddress: "", baseUrl: "https://app.verdictvaut.test" };
      return { accessSecret: "test-access-secret", refreshSecret: "test-refresh-secret", accessTtl: "15m", refreshTtl: "7d" };
    },
  };
  return new AuthService(prisma, new JwtService(), config as never, auditLog, emailProvider);
}

describe("resendVerificationEmail (real Postgres, real registration flow)", () => {
  it("issues a fresh 24h token and replaces the previous one for a genuinely PENDING_VERIFICATION user", async () => {
    const emailProvider = makeFakeEmailProvider();
    const authService = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `resend-pending-${marker}@example.test`;

    await authService.register({ email, password: "a-real-password-123" });
    const afterRegister = await prisma.user.findUniqueOrThrow({ where: { email } });
    const originalHash = afterRegister.emailVerificationTokenHash;

    await authService.resendVerificationEmail(afterRegister.id);

    const afterResend = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(afterResend.emailVerificationTokenHash).not.toBe(originalHash);
    expect(afterResend.emailVerificationTokenHash).toEqual(expect.any(String));
    expect(afterResend.emailVerificationTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(emailProvider.calls).toHaveLength(2); // one from register(), one from resend
    expect(emailProvider.calls[1].to).toBe(email);
  });

  it("the OLD token is genuinely invalidated — verifyEmail rejects it after a resend", async () => {
    const emailProvider = makeFakeEmailProvider();
    const authService = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `resend-invalidate-${marker}@example.test`;

    const { devVerificationToken: oldToken } = await authService.register({ email, password: "a-real-password-123" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await authService.resendVerificationEmail(user.id);

    await expect(authService.verifyEmail(oldToken!)).rejects.toThrow(/Invalid or expired/);
  });

  it("the NEW token genuinely activates the account", async () => {
    const emailProvider = makeFakeEmailProvider();
    const authService = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `resend-activate-${marker}@example.test`;

    await authService.register({ email, password: "a-real-password-123" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await authService.resendVerificationEmail(user.id);

    const newRawToken = emailProvider.calls[1].verificationUrl.split("token=")[1];
    const result = await authService.verifyEmail(newRawToken);
    expect(result.status).toBe("ACTIVE");
  });

  it("is a safe no-op for an already-ACTIVE user — no new token, no email sent", async () => {
    const emailProvider = makeFakeEmailProvider();
    const authService = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `resend-active-${marker}@example.test`;

    const { devVerificationToken } = await authService.register({ email, password: "a-real-password-123" });
    await authService.verifyEmail(devVerificationToken!);
    emailProvider.calls.length = 0; // reset — only count calls made by the resend attempt below

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await authService.resendVerificationEmail(user.id);

    expect(emailProvider.calls).toHaveLength(0);
    const stillActive = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(stillActive.status).toBe("ACTIVE");
    expect(stillActive.emailVerificationTokenHash).toBeNull();
  });

  it("is a safe no-op for a SUSPENDED user — no token, no email, status unchanged", async () => {
    const emailProvider = makeFakeEmailProvider();
    const authService = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `resend-suspended-${marker}@example.test`;

    await authService.register({ email, password: "a-real-password-123" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    emailProvider.calls.length = 0;

    await authService.resendVerificationEmail(user.id);

    expect(emailProvider.calls).toHaveLength(0);
    const stillSuspended = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stillSuspended.status).toBe("SUSPENDED");
  });

  it("never throws when the EmailProvider fails — the new token is still stored, ready for a future attempt", async () => {
    const emailProvider = makeFakeEmailProvider();
    const authService = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `resend-provider-fail-${marker}@example.test`;

    await authService.register({ email, password: "a-real-password-123" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const beforeResend = await prisma.user.findUniqueOrThrow({ where: { email } });

    emailProvider.shouldFail = true;
    await expect(authService.resendVerificationEmail(user.id)).resolves.toBeUndefined();

    const afterResend = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(afterResend.status).toBe("PENDING_VERIFICATION");
    expect(afterResend.emailVerificationTokenHash).not.toBe(beforeResend.emailVerificationTokenHash);
  });

  it("two CONCURRENT resend requests for the same user each complete without throwing, and exactly one resulting token verifies", async () => {
    const emailProvider = makeFakeEmailProvider();
    const authService = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `resend-concurrent-${marker}@example.test`;

    await authService.register({ email, password: "a-real-password-123" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    emailProvider.calls.length = 0;

    const results = await Promise.allSettled([authService.resendVerificationEmail(user.id), authService.resendVerificationEmail(user.id)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(emailProvider.calls).toHaveLength(2);

    // Postgres row-level locking serializes the two concurrent
    // updateMany calls — the row settles on exactly ONE final token
    // hash. Determine which of the two raw tokens that actually is by
    // comparing hashes directly, rather than guessing an ordering.
    const finalUser = await prisma.user.findUniqueOrThrow({ where: { email } });
    const candidateTokens = emailProvider.calls.map((c) => c.verificationUrl.split("token=")[1]);
    const winningToken = candidateTokens.find((t) => hashToken(t) === finalUser.emailVerificationTokenHash);
    expect(winningToken).toBeDefined();

    const activation = await authService.verifyEmail(winningToken!);
    expect(activation.status).toBe("ACTIVE");

    // The other, superseded token must be rejected — never a second
    // simultaneously-valid token.
    const losingToken = candidateTokens.find((t) => t !== winningToken);
    if (losingToken) {
      await expect(authService.verifyEmail(losingToken)).rejects.toThrow(/Invalid or expired/);
    }
  });

  it("resending never creates a second simultaneously-valid token — the PREVIOUS raw token is rejected once a new one has been issued", async () => {
    const emailProvider = makeFakeEmailProvider();
    const authService = makeAuthService(emailProvider);
    const marker = `${Date.now()}-${Math.random()}`;
    const email = `resend-single-valid-${marker}@example.test`;

    const { devVerificationToken: firstToken } = await authService.register({ email, password: "a-real-password-123" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await authService.resendVerificationEmail(user.id);
    const secondToken = emailProvider.calls[1].verificationUrl.split("token=")[1];

    await expect(authService.verifyEmail(firstToken!)).rejects.toThrow(/Invalid or expired/);
    const activation = await authService.verifyEmail(secondToken);
    expect(activation.status).toBe("ACTIVE");
  });
});
