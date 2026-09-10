import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { AuditActorType, User } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import { AuditLogService } from "../audit/audit-log.service";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { computeLockDurationMs, isCurrentlyLocked } from "./login-throttle.util";

const PASSWORD_SALT_ROUNDS = 12;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly auditLog: AuditLogService,
  ) {}

  async register(dto: RegisterDto): Promise<TokenPair> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException("Email is already registered");
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);
    const user = await this.prisma.user.create({
      data: { email: dto.email, passwordHash },
    });
    await this.auditLog.record({ actorId: user.id, actorType: AuditActorType.USER, action: "user.register", resourceType: "User", resourceId: user.id });

    return this.issueTokenPair(user);
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      // No actorId/resourceId — this email doesn't match a real account.
      // Recording the attempted email (never the password) is what makes
      // this table useful for spotting credential-stuffing/brute-force
      // patterns; see AuditLogService's own docblock on what's safe to
      // log here.
      await this.auditLog.record({
        actorType: AuditActorType.USER,
        action: "user.login_failed",
        resourceType: "User",
        reason: "invalid_credentials",
        after: { email: dto.email },
      });
      throw new UnauthorizedException("Invalid email or password");
    }

    // Always run the real bcrypt comparison, even while locked — timing
    // must not tell an attacker whether the account is currently
    // throttled or whether their guessed password happened to be right.
    // A locked account rejects the request regardless of the outcome.
    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    const locked = isCurrentlyLocked(user.lockedUntil);

    if (locked) {
      // Deliberately the SAME generic response as any other failure —
      // never a distinct "account temporarily locked" message, which
      // would let an attacker enumerate real emails by which response
      // they get back. The specific reason is safe to record here since
      // the audit log itself is never exposed to the caller.
      await this.auditLog.record({
        actorId: user.id,
        actorType: AuditActorType.USER,
        action: "user.login_blocked_throttled",
        resourceType: "User",
        resourceId: user.id,
        reason: "account_temporarily_locked",
        after: { lockedUntil: user.lockedUntil, passwordWasCorrect: passwordValid },
      });
      throw new UnauthorizedException("Invalid email or password");
    }

    if (!passwordValid) {
      // Atomic increment — safe under concurrent wrong-password attempts
      // against the same account (each request's own resulting count is
      // used to independently decide whether to (re)apply a lock, so a
      // burst of parallel guesses can only ever converge on the same or
      // a longer bounded lock, never corrupt the counter).
      const updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: { increment: 1 } },
      });
      const lockDurationMs = computeLockDurationMs(updated.failedLoginAttempts);
      let lockedUntil: Date | null = null;
      if (lockDurationMs > 0) {
        lockedUntil = new Date(Date.now() + lockDurationMs);
        await this.prisma.user.update({ where: { id: user.id }, data: { lockedUntil } });
      }

      await this.auditLog.record({
        actorId: user.id,
        actorType: AuditActorType.USER,
        action: "user.login_failed",
        resourceType: "User",
        resourceId: user.id,
        reason: "invalid_credentials",
        after: { failedLoginAttempts: updated.failedLoginAttempts, lockedUntil },
      });
      throw new UnauthorizedException("Invalid email or password");
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      // Successful login decays the failure state immediately — this is
      // a temporary throttle, not a lockout that persists once the real
      // owner proves who they are.
      await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    }

    if (user.status === "SUSPENDED") {
      await this.auditLog.record({
        actorId: user.id,
        actorType: AuditActorType.USER,
        action: "user.login_blocked_suspended",
        resourceType: "User",
        resourceId: user.id,
      });
      throw new ForbiddenException("Account is suspended");
    }

    await this.auditLog.record({ actorId: user.id, actorType: AuditActorType.USER, action: "user.login", resourceType: "User", resourceId: user.id });
    return this.issueTokenPair(user);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    let payload: { sub: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.get("jwt", { infer: true }).refreshSecret,
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    const tokenHash = hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { userId: payload.sub, tokenHash, revokedAt: null },
    });

    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token is no longer valid");
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status === "SUSPENDED") {
      throw new UnauthorizedException("Refresh token is no longer valid");
    }

    // Rotate: revoke the presented token, issue a fresh pair.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokenPair(user);
  }

  async logout(userId: string, refreshToken: string): Promise<void> {
    const tokenHash = hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { userId, tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.auditLog.record({ actorId: userId, actorType: AuditActorType.USER, action: "user.logout", resourceType: "User", resourceId: userId });
  }

  /**
   * Self-service password change. Revokes every one of this user's
   * refresh-token sessions on success — including the one that's about
   * to keep driving the current browser tab — the same "change your
   * password, get signed out everywhere" behavior most account systems
   * use, and simpler/safer here than trying to single out "this session"
   * from an access-token-only request (nothing ties an access token back
   * to the specific RefreshToken row that minted it).
   *
   * Deliberately Forbidden (403), not Unauthorized (401), for a wrong
   * currentPassword: this request is already authenticated (it passed
   * JwtAuthGuard) — the failure is a business-logic check, not an auth
   * failure. That distinction matters to apiFetch on the frontend, which
   * treats any 401 as "the access token expired" and silently refreshes
   * + retries — which would otherwise resubmit the same wrong password a
   * second time against this endpoint's own throttle for no reason.
   */
  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    const currentPasswordValid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!currentPasswordValid) {
      throw new ForbiddenException("Current password is incorrect");
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, PASSWORD_SALT_ROUNDS);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await this.auditLog.record({
      actorId: userId,
      actorType: AuditActorType.USER,
      action: "user.change_password",
      resourceType: "User",
      resourceId: userId,
    });
  }

  /**
   * This user's own sessions (one row per issued refresh token — see
   * RefreshToken's docblock). There is no device/IP/user-agent column on
   * this table, so that's never shown here — only what's actually
   * recorded: when it was issued, when it expires, and whether it's been
   * revoked. Capped the same way AuditLogService.list is (most-recent
   * first) — a long-lived account accrues a new row on every login and
   * every refresh-token rotation, so this is unbounded otherwise.
   */
  async listSessions(userId: string) {
    return this.prisma.refreshToken.findMany({
      where: { userId },
      select: { id: true, createdAt: true, expiresAt: true, revokedAt: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  /**
   * Revokes exactly one of the CALLING user's own sessions — the
   * `userId` filter in the `where` clause (not just an `id` lookup) is
   * what makes this IDOR-safe: a user can never revoke another user's
   * session by guessing/enumerating ids, they just get a 404 either way.
   */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException("Session not found");
    }
    await this.auditLog.record({
      actorId: userId,
      actorType: AuditActorType.USER,
      action: "user.session_revoke",
      resourceType: "RefreshToken",
      resourceId: sessionId,
    });
  }

  private async issueTokenPair(user: User): Promise<TokenPair> {
    const jwtConfig = this.config.get("jwt", { infer: true });
    const payload = { sub: user.id, email: user.email, role: user.role };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: jwtConfig.accessSecret,
      expiresIn: jwtConfig.accessTtl,
    });

    const refreshToken = await this.jwt.signAsync(payload, {
      secret: jwtConfig.refreshSecret,
      expiresIn: jwtConfig.refreshTtl,
    });

    const expiresAt = new Date(Date.now() + parseTtlToMs(jwtConfig.refreshTtl));
    await this.prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: hashToken(refreshToken), expiresAt },
    });

    return { accessToken, refreshToken };
  }
}

function parseTtlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const value = parseInt(match[1], 10);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 86_400_000;
  return value * unitMs;
}
