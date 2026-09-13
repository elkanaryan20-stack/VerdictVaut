import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { IsString } from "class-validator";

class RefreshDto {
  @IsString()
  refreshToken!: string;
}

// Tighter than the global default — these are the endpoints brute-force
// and credential-stuffing attempts actually target.
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @Throttle(AUTH_THROTTLE)
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  // Unauthenticated by design — the token itself IS the credential
  // (same shape as a password-reset link), so this must be reachable
  // without an access token. Same throttle tier as the rest of this
  // controller's credential-guessing surface.
  @Post("verify-email")
  @HttpCode(HttpStatus.OK)
  @Throttle(AUTH_THROTTLE)
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto.token);
  }

  // Phase 20 — AUTHENTICATED (JwtAuthGuard only, no @Roles) rather than
  // an unauthenticated "resend by email address" endpoint: see
  // AuthService.resendVerificationEmail's own docblock for why this is
  // both the safer and the architecturally consistent choice. No
  // request body at all — it only ever acts on the caller's own
  // account (@CurrentUser()), which is what makes email-enumeration
  // structurally impossible here rather than something a generic
  // response has to paper over. Always the same fixed response
  // regardless of what actually happened (ACTIVE/SUSPENDED/genuinely
  // pending) — see the service method for why.
  @Post("resend-verification-email")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle(AUTH_THROTTLE)
  async resendVerificationEmail(@CurrentUser() user: AuthenticatedUser) {
    await this.authService.resendVerificationEmail(user.id);
    return { message: "If your account requires verification, a new verification email has been sent." };
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  logout(@CurrentUser() user: AuthenticatedUser, @Body() dto: RefreshDto) {
    return this.authService.logout(user.id, dto.refreshToken);
  }

  // Same throttle as login/register — this endpoint's failure mode
  // (wrong currentPassword) is exactly the credential-guessing surface
  // those limits exist for.
  @Post("change-password")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @Throttle(AUTH_THROTTLE)
  changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(user.id, dto);
  }

  @Get("sessions")
  @UseGuards(JwtAuthGuard)
  listSessions(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.listSessions(user.id);
  }

  @Post("sessions/:id/revoke")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  revokeSession(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.authService.revokeSession(user.id, id);
  }
}
