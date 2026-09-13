import { Injectable, NotFoundException } from "@nestjs/common";
import { UserStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return user;
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /**
   * Phase 18 remediation — the SUPER_ADMIN-driven half of the
   * activation lifecycle (see AuthService.verifyEmail for the
   * self-service half). Exists as the operational escape hatch until a
   * real email-sending integration exists (see register()'s own
   * docblock) — an admin who has independently confirmed a user's
   * identity through some out-of-band means can unblock their account
   * without needing the user's own verification token.
   *
   * Deliberately narrow: only ever moves PENDING_VERIFICATION -> ACTIVE.
   * A SUSPENDED account is a distinct, more sensitive state this method
   * refuses to touch — there is no "un-suspend" path here, by design;
   * inventing one was out of this phase's scope.
   *
   * Idempotent: calling this again on an already-ACTIVE (or SUSPENDED)
   * user is a safe no-op — `changed: false` — never an error. The
   * caller (AdminController) uses `changed` to decide whether this
   * attempt is worth its own audit-log entry.
   */
  async adminActivate(userId: string): Promise<{ id: string; status: UserStatus; changed: boolean }> {
    const existing = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      throw new NotFoundException("User not found");
    }
    if (existing.status !== UserStatus.PENDING_VERIFICATION) {
      return { id: existing.id, status: existing.status, changed: false };
    }

    const result = await this.prisma.user.updateMany({
      where: { id: userId, status: UserStatus.PENDING_VERIFICATION },
      data: { status: UserStatus.ACTIVE },
    });
    const updated = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { id: updated.id, status: updated.status, changed: result.count > 0 };
  }
}
