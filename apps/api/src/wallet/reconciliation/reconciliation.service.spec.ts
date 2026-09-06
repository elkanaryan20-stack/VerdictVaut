import { ReconciliationService } from "./reconciliation.service";

describe("ReconciliationService", () => {
  let prisma: {
    assetNetwork: { findUnique: jest.Mock };
    walletAddress: { findMany: jest.Mock };
    deposit: { aggregate: jest.Mock };
    reconciliationRun: { create: jest.Mock };
  };
  let providerFactory: { resolve: jest.Mock };
  let provider: { getAddressBalance: jest.Mock };
  let service: ReconciliationService;

  beforeEach(() => {
    prisma = {
      assetNetwork: { findUnique: jest.fn().mockResolvedValue({ id: "an-1" }) },
      walletAddress: { findMany: jest.fn().mockResolvedValue([{ id: "wa-1", address: "addr-1" }]) },
      deposit: { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }) },
      reconciliationRun: { create: jest.fn((args: { data: unknown }) => Promise.resolve({ id: "run-1", ...(args.data as object) })) },
    };
    provider = { getAddressBalance: jest.fn() };
    providerFactory = { resolve: jest.fn().mockResolvedValue(provider) };

    service = new ReconciliationService(prisma as never, providerFactory as never);
  });

  it("reports OK when the chain balance matches the internal credited total", async () => {
    prisma.deposit.aggregate.mockResolvedValue({ _sum: { amount: "10" } });
    provider.getAddressBalance.mockResolvedValue({ address: "addr-1", assetNetworkId: "an-1", balance: "10", asOf: new Date() });

    const run = await service.run("an-1");
    expect(run.status).toBe("OK");
  });

  it("reports DISCREPANCY_FOUND when the chain balance differs from the internal credited total", async () => {
    prisma.deposit.aggregate.mockResolvedValue({ _sum: { amount: "10" } });
    provider.getAddressBalance.mockResolvedValue({ address: "addr-1", assetNetworkId: "an-1", balance: "15", asOf: new Date() });

    const run = await service.run("an-1");
    expect(run.status).toBe("DISCREPANCY_FOUND");
  });

  it("reports ERROR (never a fabricated OK) when the chain lookup itself fails", async () => {
    provider.getAddressBalance.mockRejectedValue(new Error("provider unreachable"));

    const run = await service.run("an-1");
    expect(run.status).toBe("ERROR");
  });

  it("reports OK with no chain lookups when there are no assigned addresses yet", async () => {
    prisma.walletAddress.findMany.mockResolvedValue([]);
    const run = await service.run("an-1");
    expect(run.status).toBe("OK");
    expect(providerFactory.resolve).not.toHaveBeenCalled();
  });

  it("never compares against LedgerAccount.cachedBalance — only the CREDITED Deposit sum for this specific address", async () => {
    prisma.deposit.aggregate.mockResolvedValue({ _sum: { amount: "10" } });
    provider.getAddressBalance.mockResolvedValue({ address: "addr-1", assetNetworkId: "an-1", balance: "10", asOf: new Date() });

    await service.run("an-1");
    expect(prisma.deposit.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { walletAddressId: "wa-1", status: "CREDITED" } }),
    );
  });
});
