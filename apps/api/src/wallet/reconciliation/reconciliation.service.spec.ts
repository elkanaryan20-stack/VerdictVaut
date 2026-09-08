import { ReconciliationService } from "./reconciliation.service";

describe("ReconciliationService", () => {
  let prisma: {
    assetNetwork: { findUnique: jest.Mock };
    walletAddress: { findMany: jest.Mock };
    deposit: { aggregate: jest.Mock; findMany: jest.Mock };
    ledgerTransaction: { findMany: jest.Mock };
    blockchainWatchCursor: { findUnique: jest.Mock };
    reconciliationRun: { create: jest.Mock };
  };
  let providerFactory: { resolve: jest.Mock };
  let provider: { getAddressBalance: jest.Mock };
  let service: ReconciliationService;

  beforeEach(() => {
    prisma = {
      assetNetwork: { findUnique: jest.fn().mockResolvedValue({ id: "an-1", assetId: "asset-1" }) },
      walletAddress: { findMany: jest.fn().mockResolvedValue([{ id: "wa-1", address: "addr-1" }]) },
      deposit: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      ledgerTransaction: { findMany: jest.fn().mockResolvedValue([]) },
      blockchainWatchCursor: { findUnique: jest.fn().mockResolvedValue(null) },
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
    const payload = (run as unknown as { discrepancies: { findings: Array<{ type: string; severity: string }> } }).discrepancies;
    expect(payload.findings).toContainEqual(expect.objectContaining({ type: "address_balance_mismatch", severity: "CRITICAL" }));
  });

  it("reports ERROR (never a fabricated OK) when the chain lookup itself fails", async () => {
    provider.getAddressBalance.mockRejectedValue(new Error("provider unreachable"));

    const run = await service.run("an-1");
    expect(run.status).toBe("ERROR");
    const payload = (run as unknown as { discrepancies: { findings: Array<{ type: string; severity: string }> } }).discrepancies;
    expect(payload.findings).toContainEqual(expect.objectContaining({ type: "address_lookup_failed", severity: "WARNING" }));
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

  describe("ledger/deposit consistency", () => {
    beforeEach(() => {
      prisma.walletAddress.findMany.mockResolvedValue([]); // isolate this describe block from the address-balance check
    });

    it("flags a CRITICAL discrepancy when a CREDITED deposit's ledgerTransactionId doesn't resolve to a real ledger transaction", async () => {
      prisma.deposit.findMany.mockResolvedValue([{ id: "dep-1", ledgerTransactionId: "ltx-missing", amount: "10" }]);
      prisma.ledgerTransaction.findMany.mockImplementation(({ where }: { where: { id?: unknown } }) =>
        Promise.resolve(where.id ? [] : []),
      );

      const run = await service.run("an-1");

      expect(run.status).toBe("DISCREPANCY_FOUND");
      const payload = (run as unknown as { discrepancies: { findings: Array<{ type: string; severity: string; details: unknown }> } }).discrepancies;
      expect(payload.findings).toContainEqual(
        expect.objectContaining({ type: "credited_deposit_missing_ledger_transaction", severity: "CRITICAL", details: expect.objectContaining({ depositId: "dep-1" }) }),
      );
    });

    it("does not flag a CREDITED deposit whose ledger transaction genuinely exists", async () => {
      prisma.deposit.findMany.mockResolvedValue([{ id: "dep-1", ledgerTransactionId: "ltx-1", amount: "10" }]);
      prisma.ledgerTransaction.findMany.mockImplementation(({ where }: { where: { id?: { in: string[] } } }) =>
        Promise.resolve(where.id ? [{ id: "ltx-1" }] : []),
      );

      const run = await service.run("an-1");
      expect(run.status).toBe("OK");
    });

    it("flags a CRITICAL discrepancy when a deposit-credit ledger transaction's referenced deposit is not CREDITED", async () => {
      prisma.ledgerTransaction.findMany.mockImplementation(({ where }: { where: { assetId?: string; id?: unknown } }) =>
        Promise.resolve(where.assetId ? [{ id: "ltx-1", referenceId: "dep-1" }] : []),
      );
      prisma.deposit.findMany.mockImplementation(({ where }: { where: { status?: string; id?: { in: string[] } } }) =>
        Promise.resolve(where.status ? [] : [{ id: "dep-1", assetNetworkId: "an-1", status: "PENDING", ledgerTransactionId: null }]),
      );

      const run = await service.run("an-1");

      expect(run.status).toBe("DISCREPANCY_FOUND");
      const payload = (run as unknown as { discrepancies: { findings: Array<{ type: string; severity: string }> } }).discrepancies;
      expect(payload.findings).toContainEqual(expect.objectContaining({ type: "ledger_transaction_missing_credited_deposit", severity: "CRITICAL" }));
    });

    it("ignores a deposit-credit ledger transaction whose referenced deposit belongs to a different asset/network", async () => {
      prisma.ledgerTransaction.findMany.mockImplementation(({ where }: { where: { assetId?: string; id?: unknown } }) =>
        Promise.resolve(where.assetId ? [{ id: "ltx-1", referenceId: "dep-1" }] : []),
      );
      prisma.deposit.findMany.mockImplementation(({ where }: { where: { status?: string; id?: { in: string[] } } }) =>
        Promise.resolve(where.status ? [] : [{ id: "dep-1", assetNetworkId: "an-OTHER-network", status: "CREDITED", ledgerTransactionId: "ltx-1" }]),
      );

      const run = await service.run("an-1");
      expect(run.status).toBe("OK");
    });
  });

  describe("stale cursor", () => {
    beforeEach(() => {
      prisma.walletAddress.findMany.mockResolvedValue([]); // isolate from the address-balance check
    });

    it("flags a WARNING when the cursor's last successful scan is well past the staleness threshold", async () => {
      prisma.blockchainWatchCursor.findUnique.mockResolvedValue({
        lastSuccessAt: new Date(Date.now() - 60 * 60_000), // 1 hour ago
        updatedAt: new Date(),
        lastError: "timeout",
        lastErrorAt: new Date(),
      });

      const run = await service.run("an-1");

      expect(run.status).toBe("DISCREPANCY_FOUND");
      const payload = (run as unknown as { discrepancies: { findings: Array<{ type: string; severity: string }> } }).discrepancies;
      expect(payload.findings).toContainEqual(expect.objectContaining({ type: "stale_watcher_cursor", severity: "WARNING" }));
    });

    it("does not flag a cursor that scanned successfully recently", async () => {
      prisma.blockchainWatchCursor.findUnique.mockResolvedValue({ lastSuccessAt: new Date(), updatedAt: new Date(), lastError: null, lastErrorAt: null });
      const run = await service.run("an-1");
      expect(run.status).toBe("OK");
    });

    it("never flags an asset/network that has no cursor row yet (never scanned) as stale", async () => {
      prisma.blockchainWatchCursor.findUnique.mockResolvedValue(null);
      const run = await service.run("an-1");
      expect(run.status).toBe("OK");
    });
  });
});
