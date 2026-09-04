import { ConflictException, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";

describe("AuthService", () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; create: jest.Mock };
    refreshToken: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  };
  let jwt: { signAsync: jest.Mock; verifyAsync: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), create: jest.fn() },
      refreshToken: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    };
    jwt = {
      signAsync: jest.fn().mockResolvedValue("signed.jwt.token"),
      verifyAsync: jest.fn(),
    };
    config = {
      get: jest.fn().mockReturnValue({
        accessSecret: "access-secret",
        refreshSecret: "refresh-secret",
        accessTtl: "15m",
        refreshTtl: "7d",
      }),
    };

    service = new AuthService(prisma as unknown as PrismaService, jwt as never, config as never);
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
  });

  describe("login", () => {
    it("rejects an unknown email", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.login({ email: "nobody@example.com", password: "x" })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rejects the wrong password", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", passwordHash, status: "ACTIVE" });

      await expect(service.login({ email: "a@example.com", password: "wrong-password" })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rejects a suspended account even with the correct password", async () => {
      const passwordHash = await bcrypt.hash("correct-password", 4);
      prisma.user.findUnique.mockResolvedValue({ id: "user-1", passwordHash, status: "SUSPENDED" });

      await expect(service.login({ email: "a@example.com", password: "correct-password" })).rejects.toThrow(
        ForbiddenException,
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
});
