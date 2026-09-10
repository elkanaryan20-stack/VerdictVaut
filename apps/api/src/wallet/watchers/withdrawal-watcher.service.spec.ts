import { WithdrawalWatcherService } from "./withdrawal-watcher.service";

describe("WithdrawalWatcherService", () => {
  let prisma: { withdrawal: { findMany: jest.Mock } };
  let custodyProviderFactory: { resolve: jest.Mock };
  let confirmationPolicy: { getRequiredConfirmations: jest.Mock };
  let withdrawalsService: { recordConfirmation: jest.Mock; fail: jest.Mock; recordProviderBroadcast: jest.Mock; failProviderRejectedSubmission: jest.Mock };
  let configService: { get: jest.Mock };
  let executorFactory: { resolve: jest.Mock };
  let getTransactionStatus: jest.Mock;
  let service: WithdrawalWatcherService;

  const broadcastRow = { id: "wd-1", assetNetworkId: "an-1", txHash: "0xhash1" };
  const pendingProviderRow = { id: "wd-2", assetNetworkId: "an-2" };

  beforeEach(() => {
    prisma = {
      withdrawal: {
        // Query-shape-aware: the BROADCAST/CONFIRMING query and the
        // PENDING_MANUAL_BROADCAST query must return independently
        // controllable fixtures, or a shared mockResolvedValue would
        // silently feed one query's fixture into the other's handler.
        findMany: jest.fn().mockImplementation(async ({ where }: { where: { status: { in?: string[] } | string } }) => {
          const statusFilter = where.status;
          const isBroadcastQuery = typeof statusFilter === "object" && "in" in statusFilter && statusFilter.in?.includes("BROADCAST");
          if (isBroadcastQuery) return [broadcastRow];
          return [];
        }),
      },
    };
    getTransactionStatus = jest.fn().mockResolvedValue({ status: "confirmed", confirmations: 6, amount: "10", txHash: "0xhash1", assetNetworkId: "an-1" });
    custodyProviderFactory = { resolve: jest.fn().mockResolvedValue({ getTransactionStatus }) };
    confirmationPolicy = { getRequiredConfirmations: jest.fn().mockResolvedValue(12) };
    withdrawalsService = {
      recordConfirmation: jest.fn().mockResolvedValue({}),
      fail: jest.fn().mockResolvedValue({}),
      recordProviderBroadcast: jest.fn().mockResolvedValue({}),
      failProviderRejectedSubmission: jest.fn().mockResolvedValue({}),
    };
    configService = { get: jest.fn().mockReturnValue({ enabled: false, pollIntervalMs: 30000 }) };
    executorFactory = { resolve: jest.fn().mockResolvedValue({ execute: jest.fn() }) }; // no checkStatus by default — ManualBroadcastExecutor shape

    service = new WithdrawalWatcherService(
      prisma as never,
      custodyProviderFactory as never,
      confirmationPolicy as never,
      withdrawalsService as never,
      configService as never,
      executorFactory as never,
    );
  });

  it("only queries withdrawals that are BROADCAST/CONFIRMING with a recorded txHash", async () => {
    await service.pollOnce();
    expect(prisma.withdrawal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ["BROADCAST", "CONFIRMING"] }, txHash: { not: null } },
      }),
    );
  });

  it("forwards a real observed confirmation count to WithdrawalsService.recordConfirmation", async () => {
    await service.pollOnce();
    expect(withdrawalsService.recordConfirmation).toHaveBeenCalledWith("wd-1", 6, 12);
  });

  it("never mutates withdrawal state itself when the chain reports the transaction not_found — leaves it for admin reconciliation", async () => {
    getTransactionStatus.mockResolvedValue({ status: "not_found", confirmations: 0, amount: "0", txHash: "0xhash1", assetNetworkId: "an-1" });
    await service.pollOnce();
    expect(withdrawalsService.recordConfirmation).not.toHaveBeenCalled();
  });

  it("marks the withdrawal FAILED (never recordConfirmation) when the chain reports the broadcast transaction as genuinely failed (e.g. an EVM revert)", async () => {
    getTransactionStatus.mockResolvedValue({ status: "failed", confirmations: 0, amount: "0", txHash: "0xhash1", assetNetworkId: "an-1" });
    await service.pollOnce();
    expect(withdrawalsService.fail).toHaveBeenCalledWith("wd-1", expect.stringContaining("0xhash1"));
    expect(withdrawalsService.recordConfirmation).not.toHaveBeenCalled();
  });

  it("still calls recordConfirmation for a merely pending (0-confirmation) transaction", async () => {
    getTransactionStatus.mockResolvedValue({ status: "pending", confirmations: 0, amount: "10", txHash: "0xhash1", assetNetworkId: "an-1" });
    await service.pollOnce();
    expect(withdrawalsService.recordConfirmation).toHaveBeenCalledWith("wd-1", 0, 12);
  });

  it("continues to the next withdrawal when one check fails, rather than aborting the whole pass", async () => {
    prisma.withdrawal.findMany.mockImplementation(async ({ where }: { where: { status: { in?: string[] } } }) =>
      where.status.in?.includes("BROADCAST")
        ? [
            { id: "wd-1", assetNetworkId: "an-1", txHash: "0xhash1" },
            { id: "wd-1b", assetNetworkId: "an-2", txHash: "0xhash2" },
          ]
        : [],
    );
    custodyProviderFactory.resolve.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ getTransactionStatus });

    await service.pollOnce();

    expect(withdrawalsService.recordConfirmation).toHaveBeenCalledTimes(1);
    expect(withdrawalsService.recordConfirmation).toHaveBeenCalledWith("wd-1b", 6, 12);
  });

  it("pollOnce is a no-op re-entry guard while a previous pass is still running", async () => {
    let resolveFirst!: () => void;
    const pending = new Promise<void>((resolve) => (resolveFirst = resolve));
    prisma.withdrawal.findMany.mockImplementationOnce(() => pending.then(() => []));

    const firstPoll = service.pollOnce();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondPoll = service.pollOnce();

    resolveFirst();
    await Promise.all([firstPoll, secondPoll]);

    // One genuine pass now makes two queries (BROADCAST/CONFIRMING, then
    // PENDING_MANUAL_BROADCAST) — the guard's job is proven by this
    // being exactly 2 (one full pass), not 4 (which a second overlapping
    // pass slipping through would produce).
    expect(prisma.withdrawal.findMany).toHaveBeenCalledTimes(2);
  });

  describe("Phase 14B — polling a real provider's pending (PENDING_MANUAL_BROADCAST) submissions", () => {
    beforeEach(() => {
      prisma.withdrawal.findMany.mockImplementation(async ({ where }: { where: { status: { in?: string[] } | string } }) => {
        const statusFilter = where.status;
        if (typeof statusFilter === "string" && statusFilter === "PENDING_MANUAL_BROADCAST") return [pendingProviderRow];
        return [];
      });
    });

    it("does nothing when the resolved executor has no checkStatus capability (e.g. ManualBroadcastExecutor) — a human still resolves it", async () => {
      await service.pollOnce();
      expect(withdrawalsService.recordProviderBroadcast).not.toHaveBeenCalled();
      expect(withdrawalsService.failProviderRejectedSubmission).not.toHaveBeenCalled();
    });

    it("calls recordProviderBroadcast when the executor's checkStatus reports a real broadcast with a txHash", async () => {
      const checkStatus = jest.fn().mockResolvedValue({ status: "broadcast", txHash: "0xreal", providerReference: "fb-1" });
      executorFactory.resolve.mockResolvedValue({ execute: jest.fn(), checkStatus });

      await service.pollOnce();

      expect(checkStatus).toHaveBeenCalledWith("wd-2");
      expect(withdrawalsService.recordProviderBroadcast).toHaveBeenCalledWith("wd-2", "0xreal", "fb-1");
    });

    it("calls failProviderRejectedSubmission() (never the general-purpose fail()) when the executor's checkStatus reports the submission was rejected", async () => {
      const checkStatus = jest.fn().mockResolvedValue({ status: "rejected", reason: "policy blocked" });
      executorFactory.resolve.mockResolvedValue({ execute: jest.fn(), checkStatus });

      await service.pollOnce();

      expect(withdrawalsService.failProviderRejectedSubmission).toHaveBeenCalledWith("wd-2", "policy blocked");
      expect(withdrawalsService.fail).not.toHaveBeenCalled();
      expect(withdrawalsService.recordProviderBroadcast).not.toHaveBeenCalled();
    });

    it("does nothing for a still-pending or not_found status — leaves it for the next poll", async () => {
      const checkStatus = jest.fn().mockResolvedValue({ status: "pending" });
      executorFactory.resolve.mockResolvedValue({ execute: jest.fn(), checkStatus });

      await service.pollOnce();

      expect(withdrawalsService.recordProviderBroadcast).not.toHaveBeenCalled();
      expect(withdrawalsService.failProviderRejectedSubmission).not.toHaveBeenCalled();
    });

    it("continues gracefully when resolving the executor itself throws (e.g. misconfiguration)", async () => {
      executorFactory.resolve.mockRejectedValue(new Error("no executor configured"));
      await expect(service.pollOnce()).resolves.not.toThrow();
      expect(withdrawalsService.recordProviderBroadcast).not.toHaveBeenCalled();
    });
  });
});
