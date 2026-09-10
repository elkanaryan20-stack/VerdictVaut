import * as crypto from "crypto";
import { AuditLogService } from "../../src/audit/audit-log.service";
import { BlockchainDepositAdapter, RawChainDeposit } from "../../src/wallet/chain-adapters/deposit-chain-adapter.interface";
import { CustodyProvider } from "../../src/wallet/custody/custody-provider.interface";
import { FireblocksCustodyAdapter } from "../../src/wallet/executors/fireblocks/fireblocks-custody.adapter";
import { ManualBroadcastExecutor } from "../../src/wallet/executors/manual-broadcast.executor";
import { ProductionCustodyExecutor } from "../../src/wallet/executors/production-custody.executor";
import { WithdrawalExecutorFactory } from "../../src/wallet/executors/withdrawal-executor.factory";
import { SecretResolverService } from "../../src/wallet/provider-config/secret-resolver.service";
import { IndependentReconciliationService } from "../../src/wallet/reconciliation/independent-reconciliation.service";
import { createTestSuperAdmin, createTestUser, depositAddressService, depositsService, getAssetNetwork, prisma } from "./helpers";

const auditLog = new AuditLogService(prisma);

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

function fakeCustodyProviderFactory(provider: CustodyProvider) {
  return { resolve: async () => provider };
}

async function assignXrpAddress(userId: string, address: string, destinationTag: string) {
  const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");
  const wallet = await prisma.walletAddress.create({
    data: { assetNetworkId: assetNetwork.id, address, destinationTag, environment: "SANDBOX", status: "ASSIGNED" },
  });
  const assignment = await prisma.depositAddressAssignment.create({
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
  return { assetNetwork, assignment };
}

const noopAdapter: BlockchainDepositAdapter = {
  family: "XRPL" as never,
  validateNetwork: async () => undefined,
  scanForDeposits: async () => ({ deposits: [], nextCursor: "x" }),
  inspectTransaction: async () => null,
};
const noopProvider: CustodyProvider = {
  getAddressBalance: async () => ({ address: "x", assetNetworkId: "x", balance: "0", asOf: new Date() }),
  getTransactionStatus: async () => ({ txHash: "x", assetNetworkId: "x", confirmations: 0, amount: "0", status: "not_found" }),
};

describe("IndependentReconciliationService (real Postgres, fake chain adapters)", () => {
  it("a chain event that matches an internal CREDITED deposit exactly produces no discrepancy", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const { assetNetwork, assignment } = await assignXrpAddress(user.id, `rMatch${marker}`, "1");

    const raw: RawChainDeposit = {
      walletAddressId: assignment.walletAddressId,
      txHash: `HASH-${marker}`,
      eventIndex: 0,
      amount: "25",
      confirmations: 20,
      destinationTag: "1",
      rawProviderPayload: {},
    };
    await depositsService.recordObservedTransaction({
      userId: user.id,
      assetSymbol: "XRP",
      assetNetworkId: assetNetwork.id,
      walletAddressId: assignment.walletAddressId,
      txHash: raw.txHash,
      eventIndex: 0,
      amount: "25",
      confirmations: 20,
      requiredConfirmations: 1,
      destinationTag: "1",
      rawProviderPayload: {},
    });

    const adapter: BlockchainDepositAdapter = { ...noopAdapter, scanForDeposits: async () => ({ deposits: [raw], nextCursor: "c" }) };
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(adapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);

    const { discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

    // Scoped to this test's own chainIdentity, not run.status/array length
    // — the shared XRPL assetNetwork/database also carries other tests'
    // (or other integration test FILES', since the embedded Postgres
    // instance is shared for the whole run) recent CREDITED deposits,
    // which the reverse "missing chain evidence" check may legitimately
    // also flag independent of anything this test set up.
    const found = discrepancies.find((d) => d.chainIdentity === `${raw.txHash}:0`);
    expect(found).toBeUndefined();
  });

  it("detects a chain event with no matching internal deposit", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const { assetNetwork, assignment } = await assignXrpAddress(user.id, `rMissing${marker}`, "2");

    const raw: RawChainDeposit = {
      walletAddressId: assignment.walletAddressId,
      txHash: `HASH-${marker}`,
      eventIndex: 0,
      amount: "10",
      confirmations: 20,
      destinationTag: "2",
      rawProviderPayload: {},
    };
    const adapter: BlockchainDepositAdapter = { ...noopAdapter, scanForDeposits: async () => ({ deposits: [raw], nextCursor: "c" }) };
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(adapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);

    const { run, discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

    expect(run.status).toBe("DISCREPANCY_FOUND");
    // Scoped by .find(), not array length — this shared XRPL
    // assetNetwork/database also carries other tests' recent CREDITED
    // deposits, which the reverse "missing chain evidence" check
    // (running in the same call) may legitimately also flag; this test
    // only asserts on the specific finding IT caused.
    const found = discrepancies.find((d) => d.chainIdentity === `${raw.txHash}:0`);
    expect(found).toBeDefined();
    expect(found!.type).toBe("chain_event_missing_internal_deposit");
    expect(found!.severity).toBe("CRITICAL");
    expect(found!.status).toBe("OPEN");
  });

  it("detects an amount mismatch between the chain and the internal deposit record", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const { assetNetwork, assignment } = await assignXrpAddress(user.id, `rMismatch${marker}`, "3");

    await depositsService.recordObservedTransaction({
      userId: user.id,
      assetSymbol: "XRP",
      assetNetworkId: assetNetwork.id,
      walletAddressId: assignment.walletAddressId,
      txHash: `HASH-${marker}`,
      eventIndex: 0,
      amount: "10",
      confirmations: 20,
      requiredConfirmations: 1,
      destinationTag: "3",
      rawProviderPayload: {},
    });

    const raw: RawChainDeposit = {
      walletAddressId: assignment.walletAddressId,
      txHash: `HASH-${marker}`,
      eventIndex: 0,
      amount: "999", // the chain actually shows a very different amount
      confirmations: 20,
      destinationTag: "3",
      rawProviderPayload: {},
    };
    const adapter: BlockchainDepositAdapter = { ...noopAdapter, scanForDeposits: async () => ({ deposits: [raw], nextCursor: "c" }) };
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(adapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);

    const { discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

    const found = discrepancies.find((d) => d.chainIdentity === `${raw.txHash}:0`);
    expect(found).toBeDefined();
    expect(found!.type).toBe("deposit_amount_mismatch");
    expect((found!.observedState as { amount: string }).amount).toBe("999");
  });

  it("detects a recently-CREDITED internal deposit the fresh rescan does not observe", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const { assetNetwork, assignment } = await assignXrpAddress(user.id, `rGhost${marker}`, "4");

    await depositsService.recordObservedTransaction({
      userId: user.id,
      assetSymbol: "XRP",
      assetNetworkId: assetNetwork.id,
      walletAddressId: assignment.walletAddressId,
      txHash: `HASH-${marker}`,
      eventIndex: 0,
      amount: "10",
      confirmations: 20,
      requiredConfirmations: 1,
      destinationTag: "4",
      rawProviderPayload: {},
    });

    // The fresh rescan finds nothing at all for this address this time.
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(noopAdapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);
    const { discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

    const found = discrepancies.find((d) => d.type === "internal_deposit_missing_chain_evidence");
    expect(found).toBeDefined();
    expect(found!.severity).toBe("CRITICAL");
  });

  it("never trusts the persisted BlockchainWatchCursor — an independent rescan ignores it entirely", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const { assetNetwork, assignment } = await assignXrpAddress(user.id, `rIndep${marker}`, "5");

    // Seed a persisted cursor claiming everything up to "9999999" was
    // already fully scanned — a normal watcher would trust this and skip
    // ahead. The independent rescanner must ignore it completely.
    await prisma.blockchainWatchCursor.upsert({
      where: { assetNetworkId: assetNetwork.id },
      create: { assetNetworkId: assetNetwork.id, lastScannedPointer: "9999999" },
      update: { lastScannedPointer: "9999999" },
    });

    let cursorSeenByAdapter: string | null = "not-called";
    const raw: RawChainDeposit = {
      walletAddressId: assignment.walletAddressId,
      txHash: `HASH-${marker}`,
      eventIndex: 0,
      amount: "10",
      confirmations: 20,
      destinationTag: "5",
      rawProviderPayload: {},
    };
    const adapter: BlockchainDepositAdapter = {
      ...noopAdapter,
      scanForDeposits: async (params) => {
        cursorSeenByAdapter = params.cursor;
        return { deposits: [raw], nextCursor: "c" };
      },
    };
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(adapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);

    await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

    expect(cursorSeenByAdapter).toBeNull(); // NOT "9999999" — the persisted cursor was never read
  });

  it("respects an explicit SUPER_ADMIN-supplied fromPointer instead of the chain adapter's default", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const { assetNetwork, assignment } = await assignXrpAddress(user.id, `rExplicit${marker}`, "6");

    let cursorSeenByAdapter: string | null = null;
    const adapter: BlockchainDepositAdapter = {
      ...noopAdapter,
      scanForDeposits: async (params) => {
        cursorSeenByAdapter = params.cursor;
        return { deposits: [], nextCursor: "c" };
      },
    };
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(adapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);

    const run = await service.runIndependentRescan(assetNetwork.id, superAdmin.id, "explicit-42");

    expect(cursorSeenByAdapter).toBe("explicit-42");
    expect(run.run.fromPointer).toBe("explicit-42");
    void assignment;
  });

  it("a chain-provider failure produces a WARNING finding, never silently treated as OK", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const { assetNetwork } = await assignXrpAddress(user.id, `rFail${marker}`, "7");

    const adapter: BlockchainDepositAdapter = {
      ...noopAdapter,
      scanForDeposits: async () => {
        throw new Error("provider unreachable");
      },
    };
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(adapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);

    const { run, discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

    expect(run.status).toBe("ERROR");
    expect(discrepancies.some((d) => d.type === "rescan_provider_error")).toBe(true);
  });

  it("detects an in-flight withdrawal whose txHash the chain no longer recognizes", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");
    const withdrawal = await prisma.withdrawal.create({
      data: {
        userId: user.id,
        assetNetworkId: assetNetwork.id,
        destinationAddress: "rSomeExternalAddress",
        amount: "5",
        status: "CONFIRMED",
        clientWithdrawalId: `wd-${Date.now()}-${Math.random()}`,
        txHash: `MISSING-TX-${Date.now()}`,
      },
    });

    const provider: CustodyProvider = {
      ...noopProvider,
      getTransactionStatus: async () => ({ txHash: withdrawal.txHash!, assetNetworkId: assetNetwork.id, confirmations: 0, amount: "0", status: "not_found" }),
    };
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(noopAdapter) as never, fakeCustodyProviderFactory(provider) as never, auditLog);

    const { discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

    const found = discrepancies.find((d) => d.type === "withdrawal_tx_missing" && d.internalEntityId === withdrawal.id);
    expect(found).toBeDefined();
  });

  it("detects a withdrawal the chain reports as failed even though we internally believe it confirmed", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");
    const withdrawal = await prisma.withdrawal.create({
      data: {
        userId: user.id,
        assetNetworkId: assetNetwork.id,
        destinationAddress: "rSomeExternalAddress2",
        amount: "5",
        status: "CREDITED",
        clientWithdrawalId: `wd-${Date.now()}-${Math.random()}`,
        txHash: `FAILED-TX-${Date.now()}`,
      },
    });

    const provider: CustodyProvider = {
      ...noopProvider,
      getTransactionStatus: async () => ({ txHash: withdrawal.txHash!, assetNetworkId: assetNetwork.id, confirmations: 5, amount: "5", status: "failed" }),
    };
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(noopAdapter) as never, fakeCustodyProviderFactory(provider) as never, auditLog);

    const { discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

    const found = discrepancies.find((d) => d.type === "withdrawal_status_chain_mismatch" && d.internalEntityId === withdrawal.id);
    expect(found).toBeDefined();
  });

  it("re-running a rescan that re-observes the same still-OPEN discrepancy never creates a duplicate row", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const { assetNetwork, assignment } = await assignXrpAddress(user.id, `rDup${marker}`, "8");

    const raw: RawChainDeposit = {
      walletAddressId: assignment.walletAddressId,
      txHash: `HASH-${marker}`,
      eventIndex: 0,
      amount: "10",
      confirmations: 20,
      destinationTag: "8",
      rawProviderPayload: {},
    };
    const adapter: BlockchainDepositAdapter = { ...noopAdapter, scanForDeposits: async () => ({ deposits: [raw], nextCursor: "c" }) };
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(adapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);

    await service.runIndependentRescan(assetNetwork.id, superAdmin.id);
    await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

    const total = await prisma.reconciliationDiscrepancy.count({
      where: { assetNetworkId: assetNetwork.id, type: "chain_event_missing_internal_deposit", chainIdentity: `${raw.txHash}:0` },
    });
    expect(total).toBe(1);
  });

  describe("discrepancy resolution lifecycle", () => {
    it("acknowledge then resolve moves OPEN -> ACKNOWLEDGED -> RESOLVED, recording who and a note", async () => {
      const superAdmin = await createTestSuperAdmin();
      const user = await createTestUser();
      const marker = `${Date.now()}-${Math.random()}`;
      const { assetNetwork, assignment } = await assignXrpAddress(user.id, `rLifecycle${marker}`, "9");

      const raw: RawChainDeposit = {
        walletAddressId: assignment.walletAddressId,
        txHash: `HASH-${marker}`,
        eventIndex: 0,
        amount: "10",
        confirmations: 20,
        destinationTag: "9",
        rawProviderPayload: {},
      };
      const adapter: BlockchainDepositAdapter = { ...noopAdapter, scanForDeposits: async () => ({ deposits: [raw], nextCursor: "c" }) };
      const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(adapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);

      const { discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);
      const discrepancyId = discrepancies[0].id;

      expect(await service.acknowledge(discrepancyId, superAdmin.id)).toBe(true);
      let refreshed = await prisma.reconciliationDiscrepancy.findUniqueOrThrow({ where: { id: discrepancyId } });
      expect(refreshed.status).toBe("ACKNOWLEDGED");

      expect(await service.resolve(discrepancyId, superAdmin.id, "Investigated — deposit was reprocessed manually.")).toBe(true);
      refreshed = await prisma.reconciliationDiscrepancy.findUniqueOrThrow({ where: { id: discrepancyId } });
      expect(refreshed.status).toBe("RESOLVED");
      expect(refreshed.resolvedByUserId).toBe(superAdmin.id);
      expect(refreshed.resolvedAt).not.toBeNull();
      expect(refreshed.notes).toContain("reprocessed");
    });

    it("acknowledging an already-resolved discrepancy is a safe no-op, not a state regression", async () => {
      const superAdmin = await createTestSuperAdmin();
      const user = await createTestUser();
      const marker = `${Date.now()}-${Math.random()}`;
      const { assetNetwork, assignment } = await assignXrpAddress(user.id, `rNoop${marker}`, "10");

      const raw: RawChainDeposit = {
        walletAddressId: assignment.walletAddressId,
        txHash: `HASH-${marker}`,
        eventIndex: 0,
        amount: "10",
        confirmations: 20,
        destinationTag: "10",
        rawProviderPayload: {},
      };
      const adapter: BlockchainDepositAdapter = { ...noopAdapter, scanForDeposits: async () => ({ deposits: [raw], nextCursor: "c" }) };
      const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(adapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);

      const { discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);
      const discrepancyId = discrepancies[0].id;
      await service.resolve(discrepancyId, superAdmin.id, "Resolved.", "FALSE_POSITIVE");

      expect(await service.acknowledge(discrepancyId, superAdmin.id)).toBe(false);
      const refreshed = await prisma.reconciliationDiscrepancy.findUniqueOrThrow({ where: { id: discrepancyId } });
      expect(refreshed.status).toBe("FALSE_POSITIVE"); // untouched
    });
  });

  it("never mutates any balance, deposit, or withdrawal — pure observation, even when a critical discrepancy is found", async () => {
    const superAdmin = await createTestSuperAdmin();
    const user = await createTestUser();
    const marker = `${Date.now()}-${Math.random()}`;
    const { assetNetwork, assignment } = await assignXrpAddress(user.id, `rSideEffect${marker}`, "11");

    const raw: RawChainDeposit = {
      walletAddressId: assignment.walletAddressId,
      txHash: `HASH-${marker}`,
      eventIndex: 0,
      amount: "500",
      confirmations: 20,
      destinationTag: "11",
      rawProviderPayload: {},
    };
    const adapter: BlockchainDepositAdapter = { ...noopAdapter, scanForDeposits: async () => ({ deposits: [raw], nextCursor: "c" }) };
    const service = new IndependentReconciliationService(prisma, fakeAdapterFactory(adapter) as never, fakeCustodyProviderFactory(noopProvider) as never, auditLog);

    await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

    // A CRITICAL finding (a real deposit the chain shows but we never
    // recorded) must NEVER result in an automatic credit.
    const account = await prisma.ledgerAccount.findUnique({
      where: { userId_assetId: { userId: user.id, assetId: assetNetwork.assetId } },
    });
    expect(account).toBeNull();
    expect(await prisma.deposit.count({ where: { walletAddressId: assignment.walletAddressId } })).toBe(0);
  });

  describe("Phase 14B — checkPendingProviderSubmissions (real provider-adapter mismatch detection)", () => {
    function makeExecutorFactory() {
      const config = { get: () => "sandbox" } as never;
      return new WithdrawalExecutorFactory(
        prisma,
        config,
        new ManualBroadcastExecutor(),
        new ProductionCustodyExecutor(),
        new FireblocksCustodyAdapter(prisma, new SecretResolverService(), config),
      );
    }

    async function setUpFireblocksWithdrawal(status: "PENDING_MANUAL_BROADCAST" = "PENDING_MANUAL_BROADCAST") {
      const marker = `${Date.now()}-${Math.random()}`;
      const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      process.env[`FIREBLOCKS_TEST_CREDS_${marker}`] = JSON.stringify({ apiKey: "test-key", privateKey });

      const user = await createTestUser();
      const superAdmin = await createTestSuperAdmin();
      const assetNetwork = await getAssetNetwork("ETH", "ethereum-sepolia");

      const providerConfig = await prisma.custodyProviderConfig.create({
        data: {
          providerName: "Fireblocks",
          environment: "SANDBOX",
          isEnabled: true,
          apiBaseUrl: "https://sandbox-api.fireblocks.io/v1",
          credentialsSecretRef: `env:FIREBLOCKS_TEST_CREDS_${marker}`,
          vaultOrAccountRef: "0",
        },
      });
      await prisma.withdrawalExecutionConfig.upsert({
        where: { assetNetworkId: assetNetwork.id },
        create: { assetNetworkId: assetNetwork.id, environment: "SANDBOX", executorType: "PRODUCTION_CUSTODY", custodyProviderConfigId: providerConfig.id, providerAssetId: "ETH_TEST" },
        update: { executorType: "PRODUCTION_CUSTODY", custodyProviderConfigId: providerConfig.id, providerAssetId: "ETH_TEST" },
      });

      const withdrawal = await prisma.withdrawal.create({
        data: {
          userId: user.id,
          assetNetworkId: assetNetwork.id,
          destinationAddress: `0x${marker.replace(/[.-]/g, "").padEnd(40, "0").slice(0, 40)}`,
          amount: "1",
          fee: "0",
          status,
          custodyReference: `fb-tx-${marker}`,
          clientWithdrawalId: `ck-${marker}`,
        },
      });

      return { superAdmin, assetNetwork, withdrawal };
    }

    let fetchMock: jest.Mock;
    const realFetch = global.fetch;
    beforeEach(() => {
      fetchMock = jest.fn();
      global.fetch = fetchMock as never;
    });
    afterEach(() => {
      global.fetch = realFetch;
    });

    it("flags a PENDING_MANUAL_BROADCAST withdrawal the provider no longer recognizes as CRITICAL — never mutates the withdrawal itself", async () => {
      const { superAdmin, assetNetwork, withdrawal } = await setUpFireblocksWithdrawal();
      fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => JSON.stringify({ message: "not found" }) });

      const service = new IndependentReconciliationService(
        prisma,
        fakeAdapterFactory(noopAdapter) as never,
        fakeCustodyProviderFactory(noopProvider) as never,
        auditLog,
        undefined,
        makeExecutorFactory(),
      );
      const { discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

      const found = discrepancies.find((d) => d.internalEntityId === withdrawal.id);
      expect(found?.type).toBe("withdrawal_missing_from_provider");
      expect(found?.severity).toBe("CRITICAL");

      const refreshed = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
      expect(refreshed.status).toBe("PENDING_MANUAL_BROADCAST"); // untouched — read-only reconciliation, never a mutation path
    });

    it("flags a provider-rejected submission the internal state has not yet recorded", async () => {
      const { superAdmin, assetNetwork, withdrawal } = await setUpFireblocksWithdrawal();
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: withdrawal.custodyReference, status: "REJECTED" }) });

      const service = new IndependentReconciliationService(
        prisma,
        fakeAdapterFactory(noopAdapter) as never,
        fakeCustodyProviderFactory(noopProvider) as never,
        auditLog,
        undefined,
        makeExecutorFactory(),
      );
      const { discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

      const found = discrepancies.find((d) => d.internalEntityId === withdrawal.id);
      expect(found?.type).toBe("withdrawal_rejected_by_provider_unrecorded");
      expect(found?.severity).toBe("CRITICAL");
    });

    it("produces no discrepancy when the provider still reports the submission as pending — matches internal expectations", async () => {
      const { superAdmin, assetNetwork, withdrawal } = await setUpFireblocksWithdrawal();
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: withdrawal.custodyReference, status: "PENDING_SIGNATURE" }) });

      const service = new IndependentReconciliationService(
        prisma,
        fakeAdapterFactory(noopAdapter) as never,
        fakeCustodyProviderFactory(noopProvider) as never,
        auditLog,
        undefined,
        makeExecutorFactory(),
      );
      const { discrepancies } = await service.runIndependentRescan(assetNetwork.id, superAdmin.id);

      expect(discrepancies.find((d) => d.internalEntityId === withdrawal.id)).toBeUndefined();
    });
  });
});
