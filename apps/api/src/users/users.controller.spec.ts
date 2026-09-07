import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { AuditLogService } from "../audit/audit-log.service";

describe("UsersController", () => {
  let controller: UsersController;
  let usersService: { findById: jest.Mock };
  let auditLogService: { list: jest.Mock };

  beforeEach(() => {
    usersService = { findById: jest.fn() };
    auditLogService = { list: jest.fn() };
    controller = new UsersController(usersService as unknown as UsersService, auditLogService as unknown as AuditLogService);
  });

  describe("me", () => {
    it("never returns the password hash or any other internal field", async () => {
      usersService.findById.mockResolvedValue({
        id: "user-1",
        email: "a@example.com",
        role: "USER",
        status: "ACTIVE",
        createdAt: new Date("2026-01-01"),
        passwordHash: "super-secret-hash",
        totpSecret: "super-secret-totp",
      });

      const result = await controller.me({ id: "user-1", email: "a@example.com", role: "USER" });

      expect(result).toEqual({
        id: "user-1",
        email: "a@example.com",
        role: "USER",
        status: "ACTIVE",
        createdAt: new Date("2026-01-01"),
      });
      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("totpSecret");
    });
  });

  describe("securityEvents", () => {
    it("scopes the audit log query to the calling user's own id (never another user's events)", async () => {
      auditLogService.list.mockResolvedValue([]);
      await controller.securityEvents({ id: "user-1", email: "a@example.com", role: "USER" });
      expect(auditLogService.list).toHaveBeenCalledWith({ actorId: "user-1" });
    });
  });
});
