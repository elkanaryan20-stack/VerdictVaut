import { ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { DepositWatcherService } from "../wallet/watchers/deposit-watcher.service";
import { WithdrawalWatcherService } from "../wallet/watchers/withdrawal-watcher.service";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  let controller: HealthController;
  let prisma: { $queryRaw: jest.Mock };
  let depositWatcherService: { listCursorStatus: jest.Mock };
  let withdrawalWatcherService: { getStatus: jest.Mock };

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ "?column?": 1 }]) };
    depositWatcherService = { listCursorStatus: jest.fn().mockResolvedValue([]) };
    withdrawalWatcherService = {
      getStatus: jest.fn().mockReturnValue({ enabled: false, pollIntervalMs: 30000, lastPollStartedAt: null, lastPollSuccessAt: null, lastPollError: null, lastPollErrorAt: null, consecutiveFailures: 0, isStale: false }),
    };
    controller = new HealthController(
      prisma as unknown as PrismaService,
      depositWatcherService as unknown as DepositWatcherService,
      withdrawalWatcherService as unknown as WithdrawalWatcherService,
    );
  });

  describe("liveness", () => {
    it("always reports ok without touching any dependency", () => {
      const result = controller.liveness();
      expect(result.status).toBe("ok");
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe("readiness", () => {
    it("reports ok when the database is reachable and no watcher is stale", async () => {
      const result = await controller.readiness();
      expect(result.status).toBe("ok");
      expect(result.checks.database.ok).toBe(true);
      expect(result.checks.blockchainWatchers.ok).toBe(true);
    });

    it("throws 503 when the database is unreachable", async () => {
      prisma.$queryRaw.mockRejectedValue(new Error("connection refused"));
      await expect(controller.readiness()).rejects.toThrow(ServiceUnavailableException);
    });

    // Phase 18 remediation — the real Prisma error (e.g. "Can't reach
    // database server at `internal-db-host:5432`") must never reach this
    // UNAUTHENTICATED endpoint's response body. It's still logged
    // in-process (see the controller's own Logger.error call) — this
    // test only asserts on what a caller actually receives over HTTP.
    it("never exposes the real database error message, hostname, or port to the caller — only a generic status", async () => {
      prisma.$queryRaw.mockRejectedValue(
        new Error("Can't reach database server at `internal-prod-db.example.internal:5432`\n\nPlease make sure your database server is running."),
      );

      let caught: ServiceUnavailableException | undefined;
      try {
        await controller.readiness();
      } catch (error) {
        caught = error as ServiceUnavailableException;
      }

      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      const body = caught!.getResponse() as { status: string; checks: { database: { ok: boolean; error: string } } };
      const serialized = JSON.stringify(body);

      expect(body.checks.database.ok).toBe(false);
      expect(body.checks.database.error).toBe("unavailable");
      expect(serialized).not.toMatch(/internal-prod-db/i);
      expect(serialized).not.toMatch(/:5432/);
      expect(serialized).not.toMatch(/reach database server/i);
    });

    it("stays 200 but reports degraded when a watcher cursor is stale", async () => {
      depositWatcherService.listCursorStatus.mockResolvedValue([
        { assetSymbol: "BTC", networkCode: "bitcoin-mainnet", isScanStale: true },
        { assetSymbol: "ETH", networkCode: "ethereum-mainnet", isScanStale: false },
      ]);
      const result = await controller.readiness();
      expect(result.status).toBe("ok");
      expect(result.checks.blockchainWatchers.ok).toBe(false);
      expect(result.checks.blockchainWatchers.staleCount).toBe(1);
      expect(result.checks.blockchainWatchers.stale).toEqual([{ assetSymbol: "BTC", networkCode: "bitcoin-mainnet" }]);
    });

    it("never fails readiness just because the watcher status lookup itself throws", async () => {
      depositWatcherService.listCursorStatus.mockRejectedValue(new Error("boom"));
      const result = await controller.readiness();
      expect(result.status).toBe("ok");
      expect(result.checks.blockchainWatchers.ok).toBe(true);
    });

    it("stays 200 but reports degraded when the withdrawal watcher is stale", async () => {
      withdrawalWatcherService.getStatus.mockReturnValue({ enabled: true, pollIntervalMs: 30000, lastPollStartedAt: null, lastPollSuccessAt: null, lastPollError: "boom", lastPollErrorAt: new Date().toISOString(), consecutiveFailures: 3, isStale: true });
      const result = await controller.readiness();
      expect(result.status).toBe("ok");
      expect(result.checks.withdrawalWatcher.ok).toBe(false);
      expect(result.checks.withdrawalWatcher.consecutiveFailures).toBe(3);
    });

    it("never fails readiness just because the withdrawal watcher status lookup itself throws", async () => {
      withdrawalWatcherService.getStatus.mockImplementation(() => {
        throw new Error("boom");
      });
      const result = await controller.readiness();
      expect(result.status).toBe("ok");
      expect(result.checks.withdrawalWatcher.ok).toBe(true);
    });
  });
});
