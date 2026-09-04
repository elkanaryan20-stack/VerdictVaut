import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../prisma/prisma.service";
import { RolesGuard } from "./roles.guard";

function makeContext(tokenUser: { id: string; role: string } | undefined) {
  const request: { user?: unknown } = { user: tokenUser };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe("RolesGuard", () => {
  let guard: RolesGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    prisma = { user: { findUnique: jest.fn() } };
    guard = new RolesGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);
  });

  it("allows the request through when no roles are required on the route", async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(makeContext(undefined))).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("denies an unauthenticated request on a role-guarded route", async () => {
    reflector.getAllAndOverride.mockReturnValue(["ADMIN"]);
    await expect(guard.canActivate(makeContext(undefined))).resolves.toBe(false);
  });

  it("allows an active admin whose current DB role matches", async () => {
    reflector.getAllAndOverride.mockReturnValue(["ADMIN", "SUPER_ADMIN"]);
    prisma.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN", status: "ACTIVE" });

    await expect(guard.canActivate(makeContext({ id: "admin-1", role: "ADMIN" }))).resolves.toBe(true);
  });

  it("denies a plain USER even if their (stale) JWT somehow claimed ADMIN", async () => {
    reflector.getAllAndOverride.mockReturnValue(["ADMIN", "SUPER_ADMIN"]);
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", role: "USER", status: "ACTIVE" });

    await expect(guard.canActivate(makeContext({ id: "user-1", role: "ADMIN" }))).resolves.toBe(false);
  });

  it("denies (and throws) a demoted-to-suspended admin even with a still-valid access token", async () => {
    reflector.getAllAndOverride.mockReturnValue(["ADMIN", "SUPER_ADMIN"]);
    prisma.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN", status: "SUSPENDED" });

    await expect(guard.canActivate(makeContext({ id: "admin-1", role: "ADMIN" }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("denies when the user has been deleted since the token was issued", async () => {
    reflector.getAllAndOverride.mockReturnValue(["ADMIN"]);
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(guard.canActivate(makeContext({ id: "gone", role: "ADMIN" }))).rejects.toThrow(ForbiddenException);
  });
});
