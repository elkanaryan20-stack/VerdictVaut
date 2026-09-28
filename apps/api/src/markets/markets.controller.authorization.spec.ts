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
