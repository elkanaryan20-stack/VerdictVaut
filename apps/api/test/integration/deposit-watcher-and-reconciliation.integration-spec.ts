import { AuditLogService } from "../../src/audit/audit-log.service";
import { BlockchainDepositAdapter, RawChainDeposit } from "../../src/wallet/chain-adapters/deposit-chain-adapter.interface";
import { CustodyProvider } from "../../src/wallet/custody/custody-provider.interface";
import {
  auditLog,
  confirmationPolicyService,
  createTestUser,
  depositAddressService,
  depositsService,
  DepositReprocessingService,
  DepositWatcherService,
  getAssetNetwork,
  getUserAccount,
  prisma,
  ReconciliationService,
} from "./helpers";

/** Minimal in-memory fake adapter factory — no real network I/O, fully deterministic, driven by the test. */
function fakeAdapterFactory(adapter: BlockchainDepositAdapter) {
  return {
    resolve: async (assetNetworkId: string) => {
      const assetNetwork = await prisma.assetNetwork.findUniqueOrThrow({
        where: { id: assetNetworkId },
        include: { asset: true, network: true },
      });
      return {
        adapter,
        network: {
          assetNetworkId: assetNetwork.id,
          assetSymbol: assetNetwork.asset.symbol,
          assetDecimals: assetNetwork.asset.decimals,
          networkFamily: assetNetwork.network.family,
          networkCode: assetNetwork.network.code,
          contractAddress: assetNetwork.contractAddress,
          isNative: assetNetwork.isNative,
          memoRequired: assetNetwork.memoRequired,
        },
      };
    },
  };
}

/**
 * Provisions a specific address and assigns it directly to `userId`,
 * bypassing DepositAddressService.getOrAssign's FIFO pool-claim (which
 * picks the OLDEST AVAILABLE address for the asset/network — the right
 * behavior in production, but not what a test that needs a specific
 * known destinationTag wants when other AVAILABLE XRP addresses already
 * exist in the shared test database from earlier tests in this file).
 */
async function assignXrpAddress(userId: string, address: string, destinationTag: string) {
  const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");
  const wallet = await prisma.walletAddress.create({
    data: { assetNetworkId: assetNetwork.id, address, destinationTag, environment: "SANDBOX", status: "ASSIGNED" },
  });
  return prisma.depositAddressAssignment.create({
    data: {
      userId,
      assetId: assetNetwork.assetId,
      networkId: assetNetwork.networkId,
      assetNetworkId: assetNetwork.id,
      walletAddressId: wallet.id,
      destinationTag,
      environment: "SANDBOX",
    },
  });
}

describe("Deposit watcher, reprocessing, and reconciliation (real Postgres, fake chain adapters)", () => {
  describe("DepositWatcherService.scanOne", () => {
    it("credits a raw deposit reported by the adapter and persists the watch cursor", async () => {
      const user = await createTestUser();
      const marker = `${Date.now()}-${Math.random()}`;
      const assignment = await assignXrpAddress(user.id, `rWatch${marker}`, "555");
      const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");

      const raw: RawChainDeposit = {
        walletAddressId: assignment.walletAddressId,
        txHash: `HASH-${marker}`,
        eventIndex: 0,
        amount: "25",
        confirmations: 5,
        destinationTag: "555",
        rawProviderPayload: {},
      };
      const adapter: BlockchainDepositAdapter = {
        family: "XRPL" as never,
        validateNetwork: async () => undefined,
        scanForDeposits: async () => ({ deposits: [raw], nextCursor: `cursor-${marker}` }),
        inspectTransaction: async () => null,
      };

      const watcher = new DepositWatcherService(
        prisma,
        fakeAdapterFactory(adapter) as never,
        confirmationPolicyService,
        depositsService,
        { get: () => ({ enabled: false, pollIntervalMs: 30000 }) } as never,
      );

      await watcher.scanOne(assetNetwork.id);

      const account = await getUserAccount(user.id, "XRP");
      expect(account?.cachedBalance.toString()).toBe("25");

      const cursor = await prisma.blockchainWatchCursor.findUnique({ where: { assetNetworkId: assetNetwork.id } });
      expect(cursor?.lastScannedPointer).toBe(`cursor-${marker}`);
    });

    it("never includes an unassigned pool address among the addresses handed to the adapter", async () => {
      const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");
      const marker = `${Date.now()}-${Math.random()}`;
      const user = await createTestUser();
      const assigned = await assignXrpAddress(user.id, `rAssigned${marker}`, "1");
      // Provisioned but deliberately never assigned to any user.
      const unassigned = await depositAddressService.provisionAddress({
        assetNetworkId: assetNetwork.id,
        address: `rUnassigned${marker}`,
        environment: "SANDBOX",
      });

      let scannedAddresses: { walletAddressId: string }[] = [];
      const adapter: BlockchainDepositAdapter = {
        family: "XRPL" as never,
        validateNetwork: async () => undefined,
        scanForDeposits: async (params) => {
          scannedAddresses = params.addresses;
          return { deposits: [], nextCursor: "x" };
        },
        inspectTransaction: async () => null,
      };

      const watcher = new DepositWatcherService(
        prisma,
        fakeAdapterFactory(adapter) as never,
        confirmationPolicyService,
        depositsService,
        { get: () => ({ enabled: false, pollIntervalMs: 30000 }) } as never,
      );

      await watcher.scanOne(assetNetwork.id);

      const scannedIds = scannedAddresses.map((a) => a.walletAddressId);
      expect(scannedIds).toContain(assigned.walletAddressId);
      expect(scannedIds).not.toContain(unassigned.id);
    });
  });

  describe("XRP destination tag validation via the real crediting path", () => {
    it("does not credit when the destination tag does not match the assigned address's configured tag", async () => {
      const user = await createTestUser();
      const marker = `${Date.now()}-${Math.random()}`;
      const assignment = await assignXrpAddress(user.id, `rTagMismatch${marker}`, "777");
      const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");

      const deposit = await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "XRP",
        assetNetworkId: assetNetwork.id,
        walletAddressId: assignment.walletAddressId,
        txHash: `HASH-MISMATCH-${marker}`,
        amount: "40",
        confirmations: 5,
        requiredConfirmations: 1,
        destinationTag: "999", // wrong — assigned tag is "777"
      });

      expect(deposit.status).toBe("FAILED");
      expect(deposit.destinationTag).toBe("999"); // preserved, never discarded

      const account = await getUserAccount(user.id, "XRP");
      expect(account?.cachedBalance.toString() ?? "0").toBe("0");
    });

    it("credits when the destination tag matches", async () => {
      const user = await createTestUser();
      const marker = `${Date.now()}-${Math.random()}`;
      const assignment = await assignXrpAddress(user.id, `rTagMatch${marker}`, "321");
      const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");

      const deposit = await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "XRP",
        assetNetworkId: assetNetwork.id,
        walletAddressId: assignment.walletAddressId,
        txHash: `HASH-MATCH-${marker}`,
        amount: "40",
        confirmations: 5,
        requiredConfirmations: 1,
        destinationTag: "321",
      });

      expect(deposit.status).toBe("CREDITED");
      const account = await getUserAccount(user.id, "XRP");
      expect(account?.cachedBalance.toString()).toBe("40");
    });
  });

  describe("DepositReprocessingService", () => {
    it("rejects a not-yet-credited deposit when the adapter can no longer find the transaction on chain, and never touches a CREDITED one", async () => {
      const user = await createTestUser();
      const marker = `${Date.now()}-${Math.random()}`;
      const assignment = await assignXrpAddress(user.id, `rReprocess${marker}`, "111");
      const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");

      // Insufficiently confirmed — stays PENDING.
      const pending = await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "XRP",
        assetNetworkId: assetNetwork.id,
        walletAddressId: assignment.walletAddressId,
        txHash: `HASH-PENDING-${marker}`,
        amount: "5",
        confirmations: 0,
        requiredConfirmations: 5,
        destinationTag: "111",
      });
      expect(pending.status).toBe("PENDING");

      const disappearedAdapter: BlockchainDepositAdapter = {
        family: "XRPL" as never,
        validateNetwork: async () => undefined,
        scanForDeposits: async () => ({ deposits: [], nextCursor: "x" }),
        inspectTransaction: async () => null, // the tx is no longer found — reorged out
      };

      const reprocessing = new DepositReprocessingService(
        prisma,
        fakeAdapterFactory(disappearedAdapter) as never,
        confirmationPolicyService,
        depositsService,
        auditLog as AuditLogService,
      );

      const result = await reprocessing.reprocess(pending.id, "admin-1");
      expect(result.status).toBe("REJECTED");

      // Reprocessing an already-CREDITED deposit must never flip it to REJECTED.
      const creditedTxHash = `HASH-CREDITED-${marker}`;
      const credited = await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "XRP",
        assetNetworkId: assetNetwork.id,
        walletAddressId: assignment.walletAddressId,
        txHash: creditedTxHash,
        amount: "5",
        confirmations: 5,
        requiredConfirmations: 5,
        destinationTag: "111",
      });
      expect(credited.status).toBe("CREDITED");

      const stillCreditedResult = await reprocessing.reprocess(credited.id, "admin-1");
      expect(stillCreditedResult.status).toBe("CREDITED");
    });

    it("credits exactly once, never twice, if a REJECTED deposit's transaction later reappears confirmed (self-healing from a transient false 'not found')", async () => {
      const user = await createTestUser();
      const marker = `${Date.now()}-${Math.random()}`;
      const assignment = await assignXrpAddress(user.id, `rHeal${marker}`, "222");
      const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");
      const txHash = `HASH-HEAL-${marker}`;

      const pending = await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "XRP",
        assetNetworkId: assetNetwork.id,
        walletAddressId: assignment.walletAddressId,
        txHash,
        amount: "7",
        confirmations: 0,
        requiredConfirmations: 5,
        destinationTag: "222",
      });

      const { deposit: rejected, justRejected } = await depositsService.rejectIfNotCredited(pending.id, "transient provider false-negative");
      expect(justRejected).toBe(true);
      expect(rejected.status).toBe("REJECTED");

      // The exact same on-chain transaction (same txHash+eventIndex) later
      // reappears confirmed — this is safe to credit because a reorg can
      // never produce a different transaction under the same hash: same
      // identity == same underlying transfer.
      const healed = await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "XRP",
        assetNetworkId: assetNetwork.id,
        walletAddressId: assignment.walletAddressId,
        txHash,
        amount: "7",
        confirmations: 5,
        requiredConfirmations: 5,
        destinationTag: "222",
      });
      expect(healed.status).toBe("CREDITED");

      // A repeat of the exact same "healed" observation must remain a
      // no-op — exactly one ledger credit, no matter how many times this
      // is called afterward.
      await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "XRP",
        assetNetworkId: assetNetwork.id,
        walletAddressId: assignment.walletAddressId,
        txHash,
        amount: "7",
        confirmations: 5,
        requiredConfirmations: 5,
        destinationTag: "222",
      });

      const account = await getUserAccount(user.id, "XRP");
      expect(account?.cachedBalance.toString()).toBe("7"); // not 14

      const ledgerTransactions = await prisma.ledgerTransaction.findMany({
        where: { referenceType: "Deposit", referenceId: healed.id },
      });
      expect(ledgerTransactions).toHaveLength(1);
    });
  });

  describe("DepositsService.listStale", () => {
    it("surfaces an unresolved deposit that hasn't been re-checked recently, and excludes a CREDITED one", async () => {
      const user = await createTestUser();
      const marker = `${Date.now()}-${Math.random()}`;
      const assignment = await assignXrpAddress(user.id, `rStale${marker}`, "333");
      const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");

      const stalePending = await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "XRP",
        assetNetworkId: assetNetwork.id,
        walletAddressId: assignment.walletAddressId,
        txHash: `HASH-STALEPENDING-${marker}`,
        amount: "1",
        confirmations: 0,
        requiredConfirmations: 5,
        destinationTag: "333",
      });
      // Force it to look old — the real watcher would naturally leave
      // lastCheckedAt in the past simply by not having polled recently.
      await prisma.deposit.update({ where: { id: stalePending.id }, data: { lastCheckedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });

      const credited = await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "XRP",
        assetNetworkId: assetNetwork.id,
        walletAddressId: assignment.walletAddressId,
        txHash: `HASH-STALECREDITED-${marker}`,
        amount: "1",
        confirmations: 5,
        requiredConfirmations: 5,
        destinationTag: "333",
      });
      await prisma.deposit.update({ where: { id: credited.id }, data: { lastCheckedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } });

      const stale = await depositsService.listStale(60 * 60 * 1000);
      const staleIds = stale.map((d) => d.id);
      expect(staleIds).toContain(stalePending.id);
      expect(staleIds).not.toContain(credited.id); // CREDITED is resolved — not "stuck"
    });
  });

  describe("ReconciliationService", () => {
    it("flags a discrepancy when the (fake) chain balance disagrees with the internal credited total for an address", async () => {
      const user = await createTestUser();
      const marker = `${Date.now()}-${Math.random()}`;
      const assignment = await assignXrpAddress(user.id, `rReconcile${marker}`, "222");
      const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");

      await depositsService.recordObservedTransaction({
        userId: user.id,
        assetSymbol: "XRP",
        assetNetworkId: assetNetwork.id,
        walletAddressId: assignment.walletAddressId,
        txHash: `HASH-RECON-${marker}`,
        amount: "8",
        confirmations: 5,
        requiredConfirmations: 1,
        destinationTag: "222",
      });

      const fakeProvider: CustodyProvider = {
        getAddressBalance: async () => ({ address: "irrelevant", assetNetworkId: assetNetwork.id, balance: "999", asOf: new Date() }),
        getTransactionStatus: async () => ({ txHash: "x", assetNetworkId: assetNetwork.id, confirmations: 0, amount: "0", status: "not_found" }),
      };

      const reconciliation = new ReconciliationService(prisma, { resolve: async () => fakeProvider } as never);
      const run = await reconciliation.run(assetNetwork.id);

      expect(run.status).toBe("DISCREPANCY_FOUND");
    });
  });

  describe("DB constraints", () => {
    it("rejects a negative retryCount at the database level", async () => {
      const user = await createTestUser();
      const marker = `${Date.now()}-${Math.random()}`;
      const assignment = await assignXrpAddress(user.id, `rConstraint${marker}`, "1");
      const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");

      await expect(
        prisma.$executeRaw`
          INSERT INTO "deposits" ("id", "userId", "assetId", "assetNetworkId", "walletAddressId", "txHash", "amount", "confirmations", "requiredConfirmations", "retryCount", "status", "detectedAt")
          VALUES (gen_random_uuid()::text, ${user.id}, ${assetNetwork.assetId}, ${assetNetwork.id}, ${assignment.walletAddressId}, ${"HASH-NEG-" + marker}, 1, 0, 1, -1, 'PENDING', NOW())
        `,
      ).rejects.toThrow(/deposits_retry_count_non_negative_check/);
    });
  });
});
