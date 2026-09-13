import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ACTIVE_USER_KEY } from "../decorators/require-active-user.decorator";

/**
 * Phase 20 security-gate remediation — the CENTRAL, declarative
 * enforcement point for "this route must never be reachable by a
 * PENDING_VERIFICATION or SUSPENDED account", replacing what was
 * previously an ad-hoc `if (user.status !== ACTIVE) throw ...` scattered
 * inside individual service methods (OrdersService.create,
 * WithdrawalsService.request) with no equivalent protection at all on
 * other financial-adjacent mutations (e.g. deposit-address
 * self-assignment).
 *
 * Deliberately mirrors RolesGuard's own shape exactly (metadata read via
 * `Reflector.getAllAndOverride`, a live DB re-check — NEVER the JWT
 * payload's own claims, which carry no status at all — and the same
 * `ForbiddenException` failure mode): a route with no `@RequireActiveUser()`
 * decorator is entirely unaffected by this guard (`canActivate` returns
 * `true` immediately), so this can be applied incrementally to exactly
 * the routes that need it without any blanket behavior change to every
 * other authenticated endpoint (GETs, logout, session/password
 * management, resend-verification-email, verify-email all continue to
 * work for a PENDING_VERIFICATION user exactly as before — see
 * docs/email-delivery.md and AuthService's own docblocks for why those
 * specifically must remain reachable).
 *
 * The pre-existing inline checks inside OrdersService/WithdrawalsService
 * were deliberately LEFT IN PLACE alongside this guard, not removed —
 * the same "guard at the route layer AND an independent re-check at the
 * service layer" defense-in-depth pattern MarketsController/
 * ResolutionService already use for market resolution (see that
 * controller's own comment). Removing a working check to avoid
 * "duplication" would trade a real safety margin for a cosmetic
 * simplification in a real financial platform — not a good trade.
 */
@Injectable()
export class ActiveUserGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresActive = this.reflector.getAllAndOverride<boolean>(ACTIVE_USER_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiresActive) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const tokenUser = request.user;
    if (!tokenUser) {
      return false;
    }

    const currentUser = await this.prisma.user.findUnique({ where: { id: tokenUser.id } });
    if (!currentUser || currentUser.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException("Account must be verified (ACTIVE) to perform this action");
    }
    return true;
  }
}
