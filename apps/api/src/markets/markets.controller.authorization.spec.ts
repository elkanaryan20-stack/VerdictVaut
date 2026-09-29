import "reflect-metadata";
import { UserRole } from "@prisma/client";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ROLES_KEY } from "../common/decorators/roles.decorator";
import { RolesGuard } from "../common/guards/roles.guard";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { MarketsController } from "./markets.controller";

describe("MarketsController — category creation authorization (Phase 39)", () => {
  const handler = MarketsController.prototype.createCategory;

  it("requires an authenticated SUPER_ADMIN (never ADMIN, never public)", () => {
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.SUPER_ADMIN]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it("leaves the public category listing public", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MarketsController.prototype.categories)).toBeUndefined();
  });
});

/**
 * Phase 41 — pins the whole market lifecycle permission split. ADMIN runs
 * day-to-day operations (create/open/close/pause/resume); anything that
 * moves money irreversibly or voids trades (cancel, resolve, settlement
 * retry) is SUPER_ADMIN only. A decorator edit that widens any of these
 * fails here instead of silently shipping.
 */
describe("MarketsController — lifecycle authorization matrix (Phase 41)", () => {
  const proto = MarketsController.prototype as unknown as Record<string, object>;

  it.each([
    ["create", [UserRole.ADMIN, UserRole.SUPER_ADMIN]],
    ["open", [UserRole.ADMIN, UserRole.SUPER_ADMIN]],
    ["close", [UserRole.ADMIN, UserRole.SUPER_ADMIN]],
    ["pause", [UserRole.ADMIN, UserRole.SUPER_ADMIN]],
    ["resume", [UserRole.ADMIN, UserRole.SUPER_ADMIN]],
    ["cancel", [UserRole.SUPER_ADMIN]],
    ["resolve", [UserRole.SUPER_ADMIN]],
    ["retrySettlement", [UserRole.SUPER_ADMIN]],
  ])("%s requires an authenticated %j", (method, roles) => {
    expect(Reflect.getMetadata(ROLES_KEY, proto[method])).toEqual(roles);
    expect(Reflect.getMetadata(GUARDS_METADATA, proto[method])).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it("requires authentication (any role) for a user's own settlement", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.getMySettlement)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.getMySettlement)).toBeUndefined();
  });

  it("keeps market browsing public", () => {
    for (const method of ["list", "getOne", "getResolutionStatus"]) {
      expect(typeof proto[method]).toBe("function");
      expect(Reflect.getMetadata(GUARDS_METADATA, proto[method])).toBeUndefined();
    }
  });
});
