import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole, UserStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ROLES_KEY } from "../decorators/roles.decorator";

/**
 * Unlike JwtAuthGuard's identity check, this re-reads the user's role and
 * status from the database on every request rather than trusting the
 * role baked into the JWT at issue time. Admin routes gate real financial
 * actions (withdrawal approval, asset/network config, address
 * provisioning), so a demoted or suspended admin loses access
 * immediately rather than staying privileged for the rest of their
 * access token's lifetime.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const tokenUser = request.user;
    if (!tokenUser) {
      return false;
    }

    const currentUser = await this.prisma.user.findUnique({ where: { id: tokenUser.id } });
    if (!currentUser || currentUser.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException("Account is not active");
    }
    if (!requiredRoles.includes(currentUser.role)) {
      return false;
    }

    // Keep the request-scoped user in sync with the authoritative role,
    // in case a handler reads it again after this guard runs.
    request.user = { ...tokenUser, role: currentUser.role };
    return true;
  }
}
