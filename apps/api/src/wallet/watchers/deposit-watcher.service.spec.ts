import { DepositWatcherService } from "./deposit-watcher.service";

describe("DepositWatcherService", () => {
  let prisma: {
    assetNetwork: { findMany: jest.Mock };
    walletAddress: { findMany: jest.Mock };
    blockchainWatchCursor: { findUnique: jest.Mock; upsert: jest.Mock };
  };
  let adapterFactory: { resolve: jest.Mock };
  let confirmationPolicy: { getRequiredConfirmations: jest.Mock };
  let depositsService: { recordObservedTransaction: jest.Mock };
  let configService: { get: jest.Mock };
  let service: DepositWatcherService;

  const network = { assetNetworkId: "an-1", assetSymbol: "XRP", networkFamily: "XRPL", networkCode: "xrpl-testnet", contractAddress: null, isNative: true, memoRequired: true };

  beforeEach(() => {
    prisma = {
      assetNetwork: { findMany: jest.fn().mockResolvedValue([{ id: "an-1" }]) },
      walletAddress: {
        findMany: jest.fn().mockResolvedValue([
          { id: "wa-1", address: "rAddr1", destinationTag: "123", assignment: { userId: "user-1" } },
          { id: "wa-2", address: "rAddr2", destinationTag: null, assignment: null }, // unassigned — must be filtered out
        ]),
      },
      blockchainWatchCursor: { findUnique: jest.fn().mockResolvedValue({ lastScannedPointer: "cursor-0" }), upsert: jest.fn().mockResolvedValue({}) },
    };

    adapterFactory = {
      resolve: jest.fn().mockResolvedValue({
        adapter: {
          scanForDeposits: jest.fn().mockResolvedValue({
            deposits: [
              {
                walletAddressId: "wa-1",
                txHash: "HASH1",
                eventIndex: 0,
                amount: "10",
                confirmations: 5,
                destinationTag: "123",
                rawProviderPayload: {},
              },
            ],
            nextCursor: "cursor-1",
          }),
        },
        network,
      }),
    };

    confirmationPolicy = { getRequiredConfirmations: jest.fn().mockResolvedValue(1) };
    depositsService = { recordObservedTransaction: jest.fn().mockResolvedValue({}) };
    configService = { get: jest.fn().mockReturnValue({ enabled: false, pollIntervalMs: 30000 }) };

    service = new DepositWatcherService(
      prisma as never,
      adapterFactory as never,
      confirmationPolicy as never,
      depositsService as never,
      configService as never,
    );
  });

  it("only scans addresses that currently have an active assignment", async () => {
    await service.scanOne("an-1");
    const scanArgs = (await adapterFactory.resolve.mock.results[0].value).adapter.scanForDeposits.mock.calls[0][0];
    expect(scanArgs.addresses).toHaveLength(1);
    expect(scanArgs.addresses[0].walletAddressId).toBe("wa-1");
  });

  it("passes the persisted cursor into the scan and persists the returned nextCursor", async () => {
    await service.scanOne("an-1");
    const scanArgs = (await adapterFactory.resolve.mock.results[0].value).adapter.scanForDeposits.mock.calls[0][0];
    expect(scanArgs.cursor).toBe("cursor-0");
    expect(prisma.blockchainWatchCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ lastScannedPointer: "cursor-1" }) }),
    );
  });

  it("forwards a raw observation to DepositsService with the resolved owner and required confirmations", async () => {
    await service.scanOne("an-1");
    expect(depositsService.recordObservedTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        assetSymbol: "XRP",
        assetNetworkId: "an-1",
        walletAddressId: "wa-1",
        txHash: "HASH1",
        amount: "10",
        confirmations: 5,
        requiredConfirmations: 1,
        destinationTag: "123",
      }),
    );
  });

  it("does nothing (never calls the adapter) when there are no watched addresses", async () => {
    prisma.walletAddress.findMany.mockResolvedValue([]);
    await service.scanOne("an-1");
    expect(adapterFactory.resolve).not.toHaveBeenCalled();
  });

  it("pollOnce continues to the next asset/network when one fails, rather than aborting the whole pass", async () => {
    prisma.assetNetwork.findMany.mockResolvedValue([{ id: "an-1" }, { id: "an-2" }]);
    const scanOneSpy = jest.spyOn(service, "scanOne").mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);

    await service.pollOnce();

    expect(scanOneSpy).toHaveBeenCalledTimes(2);
    expect(scanOneSpy).toHaveBeenNthCalledWith(1, "an-1");
    expect(scanOneSpy).toHaveBeenNthCalledWith(2, "an-2");
  });

  it("pollOnce is a no-op re-entry guard while a previous pass is still running", async () => {
    let resolveFirst!: () => void;
    const scanOneSpy = jest
      .spyOn(service, "scanOne")
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)));

    const firstPoll = service.pollOnce();
    // Let pollOnce's internal awaits (assetNetwork.findMany, then the
    // call into scanOne) actually progress before asserting anything
    // about "still running" — otherwise scanOne may not have been
    // invoked yet and resolveFirst would still be unassigned.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondPoll = service.pollOnce(); // fired while the first is still "running"

    resolveFirst();
    await Promise.all([firstPoll, secondPoll]);

    expect(scanOneSpy).toHaveBeenCalledTimes(1);
  });
});
