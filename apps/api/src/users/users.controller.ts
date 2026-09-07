import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuditLogService } from "../audit/audit-log.service";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { UsersService } from "./users.service";

@Controller("users")
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get("me")
  async me(@CurrentUser() user: AuthenticatedUser) {
    const record = await this.usersService.findById(user.id);
    return {
      id: record.id,
      email: record.email,
      role: record.role,
      status: record.status,
      createdAt: record.createdAt,
    };
  }

  // The calling user's own security/account audit trail — safe to expose
  // as-is because AuditLog.actorId is who PERFORMED an action, so
  // filtering by "actorId = this user" can only ever return rows this
  // user generated themselves (login, logout, register, password
  // change, session revoke — see AuthService), never another user's
  // activity or an admin action merely referencing this user.
  @Get("me/security-events")
  securityEvents(@CurrentUser() user: AuthenticatedUser) {
    return this.auditLogService.list({ actorId: user.id });
  }
}
