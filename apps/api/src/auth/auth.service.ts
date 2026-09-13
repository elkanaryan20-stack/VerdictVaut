import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { AuditActorType, User, UserStatus } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import { AuditLogService } from "../audit/audit-log.service";
import { AppConfig } from "../config/configuration";
import { EMAIL_PROVIDER, EmailProvider } from "../email/email-provider.interface";
import { NoopEmailProvider } from "../email/noop-email.provider";
import { LoggingMetricsService, MetricsService } from "../observability/metrics.service";
import { PrismaService } from "../prisma/prisma.service";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { computeLockDurationMs, isCurrentlyLocked } from "./login-throttle.util";

const PASSWORD_SALT_ROUNDS = 12;

// How long a freshly-issued email-verification token remains valid.
// Generous relative to how long checking an inbox actually takes —
// there is currently no "resend" endpoint, so a token that expired too
// aggressively would strand a slow-to-verify user with no self-service
// way to recover (they'd need SUPER_ADMIN's adminActivate as the only
// way out — see UsersService).
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// Phase 18 remediation — returned ONLY outside production (see
// register()'s own docblock). Never a real field a production client
// should ever see or rely on.
export interface TokenPairWithDevVerification extends TokenPair {
  devVerificationToken?: string;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly auditLog: AuditLogService,
    // Defaulted so every existing direct `new AuthService(prisma, jwt,
    // config, auditLog)` call site (auth.service.spec.ts,
    // login-throttle.integration-spec.ts, user-activation.integration-
    // spec.ts) keeps working unchanged — real DI (AuthModule) always
    // supplies the actual bound provider/metrics regardless of these
    // defaults, same pattern as EllipticAddressRiskGate's own
    // `metrics: MetricsService = new LoggingMetricsService()`.
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider = new NoopEmailProvider(),
    private readonly metrics: MetricsService = new LoggingMetricsService(),
  ) {}

  /**
   * Phase 18 remediation — every new user starts PENDING_VERIFICATION
   * (the schema default) and now genuinely CAN leave that state: a real,
   * single-use, 24h-expiring verification token is generated here (only
   * its SHA-256 hash is stored — same pattern as RefreshToken.tokenHash)
   * and consumed by verifyEmail() below.
   *
   * This codebase has no email-sending integration yet (no SMTP/provider
   * is configured anywhere), so there is currently no real channel to
   * deliver the raw token to a production user — exactly the same
   * "real mechanism, missing the final delivery integration" situation
   * as ProductionCustodyExecutor's own placeholder. Rather than block
   * registration entirely on an unbuilt integration, or silently mark
   * everyone verified (which would defeat the point), the raw token is
   * returned directly in this response ONLY when NODE_ENV !== "production"
   * — belt-and-suspenders, the same pattern configuration.ts already
   * uses for devFundingToolsEnabled: gated on the real NODE_ENV, not a
   * separate flag that could be misconfigured on independently. A real
   * production deployment needs either a real email-sending integration
   * wired in here, or to rely on SUPER_ADMIN's adminActivate escape
   * hatch (see UsersService) until one exists — never a change to this
   * gate itself.
   */
  async register(dto: RegisterDto): Promise<TokenPairWithDevVerification> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException("Email is already registered");
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);
    const rawVerificationToken = crypto.randomBytes(32).toString("hex");
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        emailVerificationTokenHash: hashToken(rawVerificationToken),
        emailVerificationTokenExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      },
    });
    await this.auditLog.record({ actorId: user.id, actorType: AuditActorType.USER, action: "user.register", resourceType: "User", resourceId: user.id });

    // Registration itself is authoritative and must not be blocked or
    // rolled back by an email-delivery failure — see
    // sendVerificationEmailSafely's own docblock for the full failure
    // semantics. The user row above is already committed either way.
    await this.sendVerificationEmailSafely(user, rawVerificationToken);

    const tokens = await this.issueTokenPair(user);
    const nodeEnv = this.config.get("nodeEnv", { infer: true });
    if (nodeEnv === "production") {
      return tokens;
    }
    return { ...tokens, devVerificationToken: rawVerificationToken };
  }

  /**
   * Phase 20 — the self-service counterpart to register()'s own
   * verification email, for a PENDING_VERIFICATION user whose original
   * token expired, was lost, or never arrived. Deliberately
   * AUTHENTICATED (called with the caller's own user id from a valid
   * JWT — see AuthController) rather than an unauthenticated "resend by
   * email address" endpoint: JwtStrategy issues a token regardless of
   * status (only SUSPENDED blocks login itself — see login() above),
   * and JwtAuthGuard alone (no @Roles) never re-checks DB status either
   * (only RolesGuard does, for role-gated routes) — so a
   * PENDING_VERIFICATION user can already reach any JwtAuthGuard-only
   * route today, exactly like logout()/changePassword() above. Requiring
   * authentication here means this endpoint can ONLY ever act on the
   * calling user's own account, which eliminates the email-enumeration
   * surface an unauthenticated "does this email exist" endpoint would
   * otherwise need generic-response tricks to hide.
   *
   * ALWAYS returns the same shape regardless of what actually happened
   * (already-ACTIVE, SUSPENDED, or genuinely PENDING_VERIFICATION) — the
   * caller (AuthController) turns this into one fixed generic HTTP
   * response, so account status is never distinguishable from the
   * response alone.
   *
   * The token replacement itself is a single CAS-guarded updateMany
   * scoped by `{id, status: PENDING_VERIFICATION}` — the same pattern
   * verifyEmail() uses — so a concurrent verifyEmail() or a second
   * concurrent resendVerificationEmail() call can never leave the row in
   * an inconsistent state: whichever write actually lands, the OLD token
   * hash is atomically replaced (never both an old and new hash valid at
   * once — this column holds exactly one value).
   */
  async resendVerificationEmail(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== UserStatus.PENDING_VERIFICATION) {
      // Not an error — ACTIVE/SUSPENDED/deleted all resolve to the same
      // safe no-op, indistinguishable from the caller's point of view.
      return;
    }

    const rawVerificationToken = crypto.randomBytes(32).toString("hex");
    const result = await this.prisma.user.updateMany({
      where: { id: userId, status: UserStatus.PENDING_VERIFICATION },
      data: {
        emailVerificationTokenHash: hashToken(rawVerificationToken),
        emailVerificationTokenExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS),
      },
    });
    if (result.count === 0) {
      // Lost a race against a concurrent verifyEmail()/status change —
      // safe no-op, same as the check above.
      return;
    }

    await this.auditLog.record({ actorId: userId, actorType: AuditActorType.USER, action: "user.verification_email_resend_requested", resourceType: "User", resourceId: userId });
    await this.sendVerificationEmailSafely(user, rawVerificationToken);
  }

  /**
   * IMPORTANT FAILURE SEMANTICS (Phase 20): a provider failure here NEVER
   * throws back to the caller. The user's row (created/updated by
   * register()/resendVerificationEmail() immediately before this is
   * called) is already committed either way — this only decides whether
   * a real email attempt was made and logs/metrics the outcome. The user
   * remains PENDING_VERIFICATION regardless; they are never activated by
   * this method, and the SUPER_ADMIN adminActivate escape hatch (see
   * UsersService) remains available exactly as before if delivery never
   * succeeds. Never logs the raw token or the constructed verification
   * URL (it embeds the token as a query parameter) — only the recipient
   * address and a classified outcome.
   */
  private async sendVerificationEmailSafely(user: User, rawVerificationToken: string): Promise<void> {
    const tags = { flow: "verification_email" };
    this.metrics.increment("auth.verification_email.send_attempted", tags);
    try {
      const verificationUrl = this.buildVerificationUrl(rawVerificationToken);
      const result = await this.emailProvider.sendVerificationEmail({ to: user.email, verificationUrl });
      this.metrics.increment("auth.verification_email.send_accepted", tags);
      this.logger.log({ event: "auth.verification_email.sent", userId: user.id, providerMessageId: result.providerMessageId });
    } catch (error) {
      this.metrics.increment("auth.verification_email.send_failed", tags);
      this.logger.error(`Verification email send failed for user ${user.id}`, (error as Error).stack ?? String(error));
      // Never claim delivery succeeded, never rethrow — see this
      // method's own docblock.
    }
  }

  private buildVerificationUrl(rawVerificationToken: string): string {
    const baseUrl = this.config.get("email", { infer: true }).baseUrl;
    return `${baseUrl}/verify-email?token=${encodeURIComponent(rawVerificationToken)}`;
  }

  /**
   * The self-service half of the activation lifecycle — consumes the
   * token register() issued. Deliberately the SAME generic error for
   * "wrong token", "expired token", and "already-used token": no
   * response here should let a caller distinguish those (a distinct
   * "already used" response would confirm a guessed/stale token once
   * belonged to a real, now-verified account — the same enumeration-
   * safety reasoning login() already applies to its own error messages).
   *
   * The transition itself is a single CAS-guarded updateMany (matching
   * this codebase's standard idempotent-mutation pattern — see
   * WithdrawalsService.recordConfirmation) scoped by the token hash AND
   * status=PENDING_VERIFICATION together, so two concurrent submissions
   * of the same valid token can only ever both succeed at match=1 for
   * one of them; the loser's updateMany matches zero rows and gets the
   * same generic rejection, never a partial/duplicate transition.
   */
  async verifyEmail(rawToken: string): Promise<{ status: UserStatus }> {
    const tokenHash = hashToken(rawToken);
    const candidate = await this.prisma.user.findFirst({
      where: { emailVerificationTokenHash: tokenHash, status: UserStatus.PENDING_VERIFICATION },
    });

    if (!candidate || !candidate.emailVerificationTokenExpiresAt || candidate.emailVerificationTokenExpiresAt < new Date()) {
      throw new UnauthorizedException("Invalid or expired verification token");
    }

    const result = await this.prisma.user.updateMany({
      where: { id: candidate.id, emailVerificationTokenHash: tokenHash, status: UserStatus.PENDING_VERIFICATION },
      data: {
        status: UserStatus.ACTIVE,
        emailVerifiedAt: new Date(),
        emailVerificationTokenHash: null,
        emailVerificationTokenExpiresAt: null,
      },
    });
    if (result.count === 0) {
      throw new UnauthorizedException("Invalid or expired verification token");
    }

    await this.auditLog.record({
      actorId: candidate.id,
      actorType: AuditActorType.USER,
      action: "user.email_verified",
      resourceType: "User",
      resourceId: candidate.id,
      before: { status: "PENDING_VERIFICATION" },
      after: { status: "ACTIVE" },
    });

    return { status: UserStatus.ACTIVE };
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
