import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UsersService } from "./users.service";

describe("UsersService.adminActivate", () => {
  let prisma: { user: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock; updateMany: jest.Mock } };
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn() },
    };
    service = new UsersService(prisma as unknown as PrismaService);
  });

  it("throws NotFoundException for a nonexistent user", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.adminActivate("missing-id")).rejects.toThrow(NotFoundException);
  });

  it("moves a PENDING_VERIFICATION user to ACTIVE and reports changed: true", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "PENDING_VERIFICATION" });
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findUniqueOrThrow.mockResolvedValue({ id: "user-1", status: "ACTIVE" });

    const result = await service.adminActivate("user-1");

    expect(result).toEqual({ id: "user-1", status: "ACTIVE", changed: true });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", status: "PENDING_VERIFICATION" },
      data: { status: "ACTIVE" },
    });
  });

  it("is an idempotent no-op (changed: false, no write attempted) for an already-ACTIVE user", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "ACTIVE" });

    const result = await service.adminActivate("user-1");

    expect(result).toEqual({ id: "user-1", status: "ACTIVE", changed: false });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("never touches a SUSPENDED user — reports changed: false, no write attempted", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "SUSPENDED" });

    const result = await service.adminActivate("user-1");

    expect(result).toEqual({ id: "user-1", status: "SUSPENDED", changed: false });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("reports changed: false if a concurrent call already won the race (updateMany matches zero rows)", async () => {
    prisma.user.findUnique.mockResolvedValue({ id: "user-1", status: "PENDING_VERIFICATION" });
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    prisma.user.findUniqueOrThrow.mockResolvedValue({ id: "user-1", status: "ACTIVE" });

    const result = await service.adminActivate("user-1");

    expect(result.changed).toBe(false);
  });
});
