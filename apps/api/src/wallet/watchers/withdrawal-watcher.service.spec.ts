import { WithdrawalWatcherService } from "./withdrawal-watcher.service";

describe("WithdrawalWatcherService", () => {
  let prisma: { withdrawal: { findMany: jest.Mock } };
  let custodyProviderFactory: { resolve: jest.Mock };
  let confirmationPolicy: { getRequiredConfirmations: jest.Mock };
  let withdrawalsService: { recordConfirmation: jest.Mock; fail: jest.Mock };
  let configService: { get: jest.Mock };
  let getTransactionStatus: jest.Mock;
  let service: WithdrawalWatcherService;

  beforeEach(() => {
    prisma = {
      withdrawal: {
        findMany: jest.fn().mockResolvedValue([{ id: "wd-1", assetNetworkId: "an-1", txHash: "0xhash1" }]),
      },
    };
    getTransactionStatus = jest.fn().mockResolvedValue({ status: "confirmed", confirmations: 6, amount: "10", txHash: "0xhash1", assetNetworkId: "an-1" });
    custodyProviderFactory = { resolve: jest.fn().mockResolvedValue({ getTransactionStatus }) };
    confirmationPolicy = { getRequiredConfirmations: jest.fn().mockResolvedValue(12) };
    withdrawalsService = { recordConfirmation: jest.fn().mockResolvedValue({}), fail: jest.fn().mockResolvedValue({}) };
    configService = { get: jest.fn().mockReturnValue({ enabled: false, pollIntervalMs: 30000 }) };

    service = new WithdrawalWatcherService(
      prisma as never,
      custodyProviderFactory as never,
      confirmationPolicy as never,
      withdrawalsService as never,
      configService as never,
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
    prisma.withdrawal.findMany.mockResolvedValue([
      { id: "wd-1", assetNetworkId: "an-1", txHash: "0xhash1" },
      { id: "wd-2", assetNetworkId: "an-2", txHash: "0xhash2" },
    ]);
    custodyProviderFactory.resolve.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ getTransactionStatus });

    await service.pollOnce();

    expect(withdrawalsService.recordConfirmation).toHaveBeenCalledTimes(1);
    expect(withdrawalsService.recordConfirmation).toHaveBeenCalledWith("wd-2", 6, 12);
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

    expect(prisma.withdrawal.findMany).toHaveBeenCalledTimes(1);
  });
});
