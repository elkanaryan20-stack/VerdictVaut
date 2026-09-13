import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PrismaService } from "../../prisma/prisma.service";
import { ActiveUserGuard } from "./active-user.guard";

function makeContext(tokenUser: { id: string } | undefined) {
  const request: { user?: unknown } = { user: tokenUser };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe("ActiveUserGuard", () => {
  let guard: ActiveUserGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    prisma = { user: { findUnique: jest.fn() } };
    guard = new ActiveUserGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);
  });

  it("allows the request through untouched when the route has no @RequireActiveUser() decorator", async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(makeContext({ id: "user-1" }))).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("denies an unauthenticated request on a route that requires an active user", async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    await expect(guard.canActivate(makeContext(undefined))).resolves.toBe(false);
  });

  it("allows a genuinely ACTIVE user through", async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "ACTIVE" });
    await expect(guard.canActivate(makeContext({ id: "user-1" }))).resolves.toBe(true);
  });

  it("denies (and throws) a PENDING_VERIFICATION user — the exact case a real registration flow produces", async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "PENDING_VERIFICATION" });
    await expect(guard.canActivate(makeContext({ id: "user-1" }))).rejects.toThrow(ForbiddenException);
  });

  it("denies (and throws) a SUSPENDED user even with a still-valid access token", async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "SUSPENDED" });
    await expect(guard.canActivate(makeContext({ id: "user-1" }))).rejects.toThrow(ForbiddenException);
  });

  it("denies when the user has been deleted since the token was issued", async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(guard.canActivate(makeContext({ id: "gone" }))).rejects.toThrow(ForbiddenException);
  });

  it("always re-reads status live from the database — never trusts anything on the token itself", async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "ACTIVE" });
    await guard.canActivate(makeContext({ id: "user-1" }));
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: "user-1" } });
  });
});
