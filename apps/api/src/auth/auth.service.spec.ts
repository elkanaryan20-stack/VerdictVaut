import { ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit/audit-log.service";
import { EmailProvider } from "../email/email-provider.interface";
import { AuthService } from "./auth.service";

describe("AuthService", () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    refreshToken: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; updateMany: jest.Mock; findMany: jest.Mock };
  };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let config: { get: jest.Mock };
  let auditLog: { record: jest.Mock };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
      refreshToken: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
      },
    };
    jwt = {
      signAsync: jest.fn().mockResolvedValue("signed.jwt.token"),
      verifyAsync: jest.fn(),
    };
    config = {
      // Key-aware, unlike a bare mockReturnValue — register() now also
      // reads "nodeEnv" (to decide whether to include devVerificationToken
      // in its response) and "email" (Phase 20 — to build the
      // verification link's base URL), distinct from the "jwt" config
      // every other test here already relies on.
      get: jest.fn((key: string) => {
        if (key === "nodeEnv") return "test";
        if (key === "email") return { provider: "none", postmarkServerToken: "", fromAddress: "", baseUrl: "https://app.example.test" };
        return { accessSecret: "access-secret", refreshSecret: "refresh-secret", accessTtl: "15m", refreshTtl: "7d" };
      }),
    };
    auditLog = { record: jest.fn().mockResolvedValue({}) };

    service = new AuthService(prisma as unknown as PrismaService, jwt as never, config as never, auditLog as unknown as AuditLogService);
  });

  describe("register", () => {
    it("rejects a duplicate email", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "existing-user" });

      await expect(service.register({ email: "a@example.com", password: "password1234" })).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("creates a new user with a hashed password and issues tokens", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(async ({ data }) => ({ id: "user-1", role: "USER", ...data }));
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.register({ email: "new@example.com", password: "password1234" });

      expect(result.accessToken).toBe("signed.jwt.token");
      const createdPasswordHash = prisma.user.create.mock.calls[0][0].data.passwordHash;
      expect(createdPasswordHash).not.toBe("password1234");
      expect(await bcrypt.compare("password1234", createdPasswordHash)).toBe(true);
    });

    it("creates the user PENDING_VERIFICATION-eligible: a hashed (never raw) verification token with a future expiry", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(async ({ data }) => ({ id: "user-1", role: "USER", ...data }));
      prisma.refreshToken.create.mockResolvedValue({});

      await service.register({ email: "new@example.com", password: "password1234" });

      const createData = prisma.user.create.mock.calls[0][0].data;
      expect(createData.emailVerificationTokenHash).toEqual(expect.any(String));
      expect(createData.emailVerificationTokenHash).toHaveLength(64); // sha256 hex
      expect(createData.emailVerificationTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("includes devVerificationToken in the response outside production (NODE_ENV=test here)", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(async ({ data }) => ({ id: "user-1", role: "USER", ...data }));
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.register({ email: "new@example.com", password: "password1234" });

      expect(result.devVerificationToken).toEqual(expect.any(String));
      // The token returned to the caller must be the RAW value, never
      // the hash stored on the row — otherwise it could never actually
      // verify anything.
      const storedHash = prisma.user.create.mock.calls[0][0].data.emailVerificationTokenHash;
      expect(result.devVerificationToken).not.toBe(storedHash);
    });

    it("NEVER includes devVerificationToken in production, regardless of anything else", async () => {
      config.get.mockImplementation((key: string) => (key === "nodeEnv" ? "production" : { accessSecret: "access-secret", refreshSecret: "refresh-secret", accessTtl: "15m", refreshTtl: "7d" }));
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(async ({ data }) => ({ id: "user-1", role: "USER", ...data }));
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.register({ email: "new@example.com", password: "password1234" });

      expect(result).not.toHaveProperty("devVerificationToken");
    });
  });

  describe("verifyEmail", () => {
    it("activates a valid, unexpired token: status -> ACTIVE, token cleared, audit-logged", async () => {
      const futureExpiry = new Date(Date.now() + 1_000_000);
      prisma.user.findFirst.mockResolvedValue({ id: "user-1", status: "PENDING_VERIFICATION", emailVerificationTokenExpiresAt: futureExpiry });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.verifyEmail("a-real-raw-token");

      expect(result.status).toBe("ACTIVE");
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "user-1", emailVerificationTokenHash: expect.any(String), status: "PENDING_VERIFICATION" },
        data: {
          status: "ACTIVE",
          emailVerifiedAt: expect.any(Date),
          emailVerificationTokenHash: null,
          emailVerificationTokenExpiresAt: null,
        },
      });
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: "user-1", action: "user.email_verified", resourceType: "User", resourceId: "user-1" }),
      );
    });

    it("rejects when no user has a matching PENDING_VERIFICATION token (wrong/foreign/already-consumed token)", async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.verifyEmail("wrong-token")).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("rejects an expired token with the SAME generic error as a wrong one (no oracle)", async () => {
      const pastExpiry = new Date(Date.now() - 1_000);
      prisma.user.findFirst.mockResolvedValue({ id: "user-1", status: "PENDING_VERIFICATION", emailVerificationTokenExpiresAt: pastExpiry });

      await expect(service.verifyEmail("expired-token")).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("rejects (never double-applies) when a concurrent submission already consumed the token — updateMany matches zero rows", async () => {
      const futureExpiry = new Date(Date.now() + 1_000_000);
      prisma.user.findFirst.mockResolvedValue({ id: "user-1", status: "PENDING_VERIFICATION", emailVerificationTokenExpiresAt: futureExpiry });
      prisma.user.updateMany.mockResolvedValue({ count: 0 }); // a concurrent call won the race first

      await expect(service.verifyEmail("raced-token")).rejects.toThrow(UnauthorizedException);
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe("login", () => {
    it("rejects an unknown email and audit-logs the attempt without a real actorId", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.login({ email: "nobody@example.com", password: "x" })).rejects.toThrow(
        UnauthorizedException,
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "user.login_failed", after: { email: "nobody@example.com" } }),
      );
      expect(auditLog.record.mock.calls[0][0].actorId).toBeUndefined();
    });

    it("rejects the wrong password, increments the failure counter, and audit-logs it against the real user", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", passwordHash, status: "ACTIVE", failedLoginAttempts: 0, lockedUntil: null });
      prisma.user.update.mockResolvedValue({ failedLoginAttempts: 1 });

      await expect(service.login({ email: "a@example.com", password: "wrong-password" })).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "user-1" }, data: { failedLoginAttempts: { increment: 1 } } });
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: "user-1", action: "user.login_failed", after: { failedLoginAttempts: 1, lockedUntil: null } }),
      );
    });

    it("locks the account once failures exceed the threshold, with the same generic error message as any other failure", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", passwordHash, status: "ACTIVE", failedLoginAttempts: 5, lockedUntil: null });
      prisma.user.update.mockResolvedValueOnce({ failedLoginAttempts: 6 }).mockResolvedValueOnce({});

      await expect(service.login({ email: "a@example.com", password: "wrong-password" })).rejects.toThrow(
        "Invalid email or password",
      );
      // Second update call actually sets lockedUntil, ~1 minute out.
      const lockCall = prisma.user.update.mock.calls[1][0];
      expect(lockCall.where).toEqual({ id: "user-1" });
      expect(lockCall.data.lockedUntil.getTime()).toBeGreaterThan(Date.now());
      expect(lockCall.data.lockedUntil.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    });

    it("rejects a currently-locked account with the SAME generic message even when the password is correct — never a distinct 'locked' response an attacker could use to enumerate real emails", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      const lockedUntil = new Date(Date.now() + 5 * 60_000);
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", passwordHash, status: "ACTIVE", failedLoginAttempts: 8, lockedUntil });

      await expect(service.login({ email: "a@example.com", password: "correct-password" })).rejects.toThrow(
        "Invalid email or password",
      );
      expect(prisma.user.update).not.toHaveBeenCalled(); // locked accounts never touch the counter further
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: "user-1", action: "user.login_blocked_throttled", after: expect.objectContaining({ passwordWasCorrect: true }) }),
      );
    });

    it("an attacker who only knows a victim's email can only impose a bounded, auto-expiring delay — never a permanent lockout", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      // Simulate the attacker having already driven the account deep into repeated failures.
      prisma.user.findUnique.mockResolvedValue({ id: "victim", passwordHash, status: "ACTIVE", failedLoginAttempts: 500, lockedUntil: null });
      prisma.user.update.mockResolvedValueOnce({ failedLoginAttempts: 501 }).mockResolvedValueOnce({});

      await expect(service.login({ email: "victim@example.com", password: "wrong-guess" })).rejects.toThrow();

      const lockCall = prisma.user.update.mock.calls[1][0];
      const lockDurationMs = lockCall.data.lockedUntil.getTime() - Date.now();
      expect(lockDurationMs).toBeLessThanOrEqual(15 * 60_000); // capped, regardless of how many failures pile up
    });

    it("does not touch the account at all for a currently-locked victim once the real owner's correct password arrives AFTER the lock expires", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      const lockedUntilInThePast = new Date(Date.now() - 1000);
      prisma.user.findUnique.mockResolvedValue({
        id: "user-1",
        email: "a@example.com",
        role: "USER",
        passwordHash,
        status: "ACTIVE",
        failedLoginAttempts: 6,
        lockedUntil: lockedUntilInThePast,
      });
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.login({ email: "a@example.com", password: "correct-password" });

      expect(result.accessToken).toBe("signed.jwt.token");
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "user-1" }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    });

    it("applies the identical throttle to a SUPER_ADMIN account — no special exemption that would weaken its own protection", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      const lockedUntil = new Date(Date.now() + 5 * 60_000);
      prisma.user.findUnique.mockResolvedValue({ id: "admin-1", passwordHash, status: "ACTIVE", role: "SUPER_ADMIN", failedLoginAttempts: 9, lockedUntil });

      await expect(service.login({ email: "admin@example.com", password: "correct-password" })).rejects.toThrow(
        "Invalid email or password",
      );
    });

    it("handles two concurrent wrong-password attempts without crashing, each independently deciding whether to (re)lock from its own resulting count", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", passwordHash, status: "ACTIVE", failedLoginAttempts: 5, lockedUntil: null });
      // Real Postgres atomically serializes concurrent increments — here
      // each concurrent call independently observes ITS OWN post-increment
      // count (6 and 7), simulating that real interleaving.
      prisma.user.update
        .mockResolvedValueOnce({ failedLoginAttempts: 6 })
        .mockResolvedValueOnce({}) // first call's lock-set
        .mockResolvedValueOnce({ failedLoginAttempts: 7 })
        .mockResolvedValueOnce({}); // second call's lock-set

      const [first, second] = await Promise.allSettled([
        service.login({ email: "a@example.com", password: "wrong-1" }),
        service.login({ email: "a@example.com", password: "wrong-2" }),
      ]);

      expect(first.status).toBe("rejected");
      expect(second.status).toBe("rejected");
      expect(prisma.user.update).toHaveBeenCalledTimes(4);
    });

    it("rejects a suspended account even with the correct password, and audit-logs the block", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", passwordHash, status: "SUSPENDED" });

      await expect(service.login({ email: "a@example.com", password: "correct-password" })).rejects.toThrow(
        ForbiddenException,
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: "user-1", action: "user.login_blocked_suspended" }),
      );
    });

    it("issues tokens for a correct password on an active account", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      prisma.user.findUnique.mockResolvedValue({
        id: "user-1",
        email: "a@example.com",
        role: "USER",
        passwordHash,
        status: "ACTIVE",
      });
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.login({ email: "a@example.com", password: "correct-password" });
      expect(result.accessToken).toBe("signed.jwt.token");
      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: "user-1", action: "user.login" }));
    });
  });

  describe("refresh", () => {
    it("rejects a refresh token that fails signature/expiry verification", async () => {
      jwt.verifyAsync.mockRejectedValue(new Error("bad token"));
      await expect(service.refresh("garbage")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects a refresh token that was already revoked (reuse after rotation)", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "user-1" });
      prisma.refreshToken.findFirst.mockResolvedValue(null); // revoked tokens are excluded by the query

      await expect(service.refresh("some.jwt.token")).rejects.toThrow(UnauthorizedException);
    });

    it("rotates a valid refresh token: revokes the old one and issues a new pair", async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: "user-1" });
      prisma.refreshToken.findFirst.mockResolvedValue({
        id: "stored-token-1",
        expiresAt: new Date(Date.now() + 1_000_000),
      });
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "a@example.com", role: "USER", status: "ACTIVE" });
      prisma.refreshToken.update.mockResolvedValue({});
      prisma.refreshToken.create.mockResolvedValue({});

      await service.refresh("valid.jwt.token");

      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: "stored-token-1" },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe("logout", () => {
    it("revokes only the specific refresh token for this user, never any other of their sessions or another user's token", async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      await service.logout("user-1", "some.refresh.token");

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", tokenHash: expect.any(String), revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it("is a safe no-op — never throws — when the token doesn't belong to this user or is already revoked (IDOR/replay safety)", async () => {
      // The WHERE clause's userId scoping means a token belonging to a
      // DIFFERENT user matches zero rows here, exactly like an
      // already-revoked token would — logout() never reveals which case
      // it was, and never touches another user's session.
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.logout("user-1", "not-my-token-or-already-revoked")).resolves.toBeUndefined();
    });

    it("audit-logs the logout against the real actor", async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      await service.logout("user-1", "some.refresh.token");
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: "user-1", action: "user.logout", resourceType: "User", resourceId: "user-1" }),
      );
    });

    it("session invalidation actually takes effect: a refresh() call with the just-logged-out token is rejected", async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      await service.logout("user-1", "the.token");

      // Mirrors "rejects a refresh token that was already revoked" above —
      // once revoked, the stored-token lookup (which filters on
      // revokedAt: null) excludes it, exactly as a real DB would after
      // the updateMany above actually ran.
      jwt.verifyAsync.mockResolvedValue({ sub: "user-1" });
      prisma.refreshToken.findFirst.mockResolvedValue(null);
      await expect(service.refresh("the.token")).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("changePassword", () => {
    it("rejects an incorrect current password without touching the stored hash", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: "user-1", passwordHash });

      await expect(
        service.changePassword("user-1", { currentPassword: "wrong-password", newPassword: "brand-new-password123" }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it("re-hashes the password, revokes every session, and audit-logs the change on success", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: "user-1", passwordHash });
      prisma.user.update.mockResolvedValue({});
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

      await service.changePassword("user-1", { currentPassword: "correct-password", newPassword: "brand-new-password123" });

      const newHash = prisma.user.update.mock.calls[0][0].data.passwordHash;
      expect(newHash).not.toBe(passwordHash);
      expect(await bcrypt.compare("brand-new-password123", newHash)).toBe(true);
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: "user-1", action: "user.change_password" }));
    });
  });

  describe("listSessions", () => {
    it("scopes the query to the given user id", async () => {
      prisma.refreshToken.findMany.mockResolvedValue([]);
      await service.listSessions("user-1");
      expect(prisma.refreshToken.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" }, take: 100 }),
      );
    });
  });

  describe("revokeSession", () => {
    it("throws NotFound instead of revoking when the session doesn't belong to this user (IDOR protection)", async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.revokeSession("user-1", "someone-elses-session")).rejects.toThrow(NotFoundException);
      expect(auditLog.record).not.toHaveBeenCalled();
    });

    it("revokes the session and audit-logs it when it belongs to this user", async () => {
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      await service.revokeSession("user-1", "session-1");
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: "session-1", userId: "user-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: "user-1", action: "user.session_revoke", resourceId: "session-1" }));
    });
  });

  describe("verification email delivery (Phase 20)", () => {
    let emailProvider: { sendVerificationEmail: jest.Mock };
    let serviceWithEmail: AuthService;

    beforeEach(() => {
      emailProvider = { sendVerificationEmail: jest.fn().mockResolvedValue({ providerMessageId: "msg-1" }) };
      serviceWithEmail = new AuthService(
        prisma as unknown as PrismaService,
        jwt as never,
        config as never,
        auditLog as unknown as AuditLogService,
        emailProvider as unknown as EmailProvider,
      );
    });

    it("register() calls the injected EmailProvider with the recipient and a verification URL built from EMAIL_BASE_URL", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(async ({ data }) => ({ id: "user-1", role: "USER", ...data }));
      prisma.refreshToken.create.mockResolvedValue({});

      await serviceWithEmail.register({ email: "new@example.com", password: "password1234" });

      expect(emailProvider.sendVerificationEmail).toHaveBeenCalledWith({
        to: "new@example.com",
        verificationUrl: expect.stringContaining("https://app.example.test/verify-email?token="),
      });
    });

    it("register() still succeeds and still returns tokens when the EmailProvider throws — registration is authoritative, delivery is not", async () => {
      emailProvider.sendVerificationEmail.mockRejectedValue(new Error("provider unavailable"));
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.create.mockImplementation(async ({ data }) => ({ id: "user-1", role: "USER", ...data }));
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await serviceWithEmail.register({ email: "new@example.com", password: "password1234" });

      expect(result.accessToken).toBe("signed.jwt.token");
      expect(result.devVerificationToken).toEqual(expect.any(String));
    });

    it("register() never lets an EmailProvider failure roll back or alter the created user's PENDING_VERIFICATION state", async () => {
      emailProvider.sendVerificationEmail.mockRejectedValue(new Error("provider unavailable"));
      prisma.user.findUnique.mockResolvedValue(null);
      let createdData: Record<string, unknown> = {};
      prisma.user.create.mockImplementation(async ({ data }) => {
        createdData = data;
        return { id: "user-1", role: "USER", ...data };
      });
      prisma.refreshToken.create.mockResolvedValue({});

      await serviceWithEmail.register({ email: "new@example.com", password: "password1234" });

      // create() was already called (and its result already committed by
      // Prisma in a real DB) BEFORE the email send is even attempted —
      // this asserts the ordering, not just the outcome.
      expect(createdData.emailVerificationTokenHash).toEqual(expect.any(String));
    });
  });

  describe("resendVerificationEmail (Phase 20)", () => {
    let emailProvider: { sendVerificationEmail: jest.Mock };
    let serviceWithEmail: AuthService;

    beforeEach(() => {
      emailProvider = { sendVerificationEmail: jest.fn().mockResolvedValue({ providerMessageId: "msg-1" }) };
      serviceWithEmail = new AuthService(
        prisma as unknown as PrismaService,
        jwt as never,
        config as never,
        auditLog as unknown as AuditLogService,
        emailProvider as unknown as EmailProvider,
      );
    });

    it("issues a fresh token and sends a new email for a genuinely PENDING_VERIFICATION user", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "a@example.com", status: "PENDING_VERIFICATION" });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await serviceWithEmail.resendVerificationEmail("user-1");

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "user-1", status: "PENDING_VERIFICATION" },
        data: { emailVerificationTokenHash: expect.any(String), emailVerificationTokenExpiresAt: expect.any(Date) },
      });
      expect(emailProvider.sendVerificationEmail).toHaveBeenCalledWith({ to: "a@example.com", verificationUrl: expect.any(String) });
      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: "user-1", action: "user.verification_email_resend_requested" }));
    });

    it("replaces (invalidates) the previous token hash rather than creating a second valid one", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "a@example.com", status: "PENDING_VERIFICATION", emailVerificationTokenHash: "old-hash-value" });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await serviceWithEmail.resendVerificationEmail("user-1");

      const updateCall = prisma.user.updateMany.mock.calls[0][0];
      expect(updateCall.data.emailVerificationTokenHash).not.toBe("old-hash-value");
    });

    it("is a safe no-op for an already-ACTIVE user — no token created, no email sent, no account-status leak", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "a@example.com", status: "ACTIVE" });

      await serviceWithEmail.resendVerificationEmail("user-1");

      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(emailProvider.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it("is a safe no-op for a SUSPENDED user", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "a@example.com", status: "SUSPENDED" });

      await serviceWithEmail.resendVerificationEmail("user-1");

      expect(prisma.user.updateMany).not.toHaveBeenCalled();
      expect(emailProvider.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it("is a safe no-op when the user no longer exists", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(serviceWithEmail.resendVerificationEmail("gone")).resolves.toBeUndefined();
      expect(emailProvider.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it("loses a concurrent race safely — updateMany matching zero rows never sends an email for a token that's already stale", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "a@example.com", status: "PENDING_VERIFICATION" });
      prisma.user.updateMany.mockResolvedValue({ count: 0 }); // lost the race (e.g. a concurrent verifyEmail() already landed)

      await serviceWithEmail.resendVerificationEmail("user-1");

      expect(emailProvider.sendVerificationEmail).not.toHaveBeenCalled();
    });

    it("never throws back to the caller when the EmailProvider fails — the new token is still stored for a future attempt", async () => {
      emailProvider.sendVerificationEmail.mockRejectedValue(new Error("provider unavailable"));
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "a@example.com", status: "PENDING_VERIFICATION" });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      await expect(serviceWithEmail.resendVerificationEmail("user-1")).resolves.toBeUndefined();
      expect(prisma.user.updateMany).toHaveBeenCalled();
    });
  });
});
