import { ConflictException, ForbiddenException } from "@nestjs/common";
import { CustodyProvider, ChainTransactionStatus } from "../../src/wallet/custody/custody-provider.interface";
import { DeferredComplianceGate } from "../../src/wallet/withdrawals/compliance/deferred-compliance-gate";
import { ZeroWithdrawalFeeCalculator } from "../../src/wallet/withdrawals/fees/zero-withdrawal-fee.calculator";
import { ReconciliationSchedulerService } from "../../src/operations/reconciliation-scheduler.service";
import { ScheduledJobStateService } from "../../src/operations/scheduled-job-state.service";
import { IndependentReconciliationService } from "../../src/wallet/reconciliation/independent-reconciliation.service";
import { BlockchainDepositAdapter } from "../../src/wallet/chain-adapters/deposit-chain-adapter.interface";
import {
  auditLog,
  createTestSuperAdmin,
  createTestUser,
  executorFactory,
  fundUserForTest,
  getAssetNetwork,
  getUserAccount,
  ledger,
  prisma,
  reservations,
  txRunner,
  withdrawalsService,
  WithdrawalsService,
} from "./helpers";

/**
 * Phase 35 — operational control plane: the reconciliation scheduler's
 * cross-instance lease, discrepancy de-duplication, R1 stuck-withdrawal
 * recovery, and mismatch-audit de-duplication, all against real Postgres.
 */

const schedulerConfig = (overrides: Partial<{ intervalMs: number; leaseStaleAfterMs: number }> = {}) =>
  ({
    get: () => ({ enabled: false, intervalMs: 3_600_000, tickIntervalMs: 60_000, leaseStaleAfterMs: 1_800_000, ...overrides }),
  }) as never;

function makeScheduler(independent: unknown, collateral: unknown, config = schedulerConfig()) {
  return new ReconciliationSchedulerService(prisma, config, new ScheduledJobStateService(prisma), independent as never, collateral as never);
}

function countingJobs(delayMs = 50) {
  const independentCalls: string[] = [];
  let collateralCalls = 0;
  const independent = {
    runIndependentRescan: async (assetNetworkId: string) => {
      independentCalls.push(assetNetworkId);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { run: { status: "OK" }, discrepancies: [] };
    },
  };
  const collateral = {
    checkAllMarkets: async () => {
      collateralCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { checked: 0, truncated: false, discrepanciesFound: 0, results: [] };
    },
  };
  return { independent, collateral, independentCalls, collateralCallCount: () => collateralCalls };
}

async function activeAssetNetworkCount() {
  return prisma.assetNetwork.count({ where: { isActive: true, asset: { isActive: true }, network: { isActive: true } } });
}

describe("Phase 35 — reconciliation scheduler (real Postgres leases)", () => {
  beforeEach(async () => {
    await prisma.scheduledJobState.deleteMany({});
  });

  it("two replicas ticking CONCURRENTLY run every job exactly once between them — never twice", async () => {
    const jobs = countingJobs();
    const replicaA = makeScheduler(jobs.independent, jobs.collateral);
    const replicaB = makeScheduler(jobs.independent, jobs.collateral);

    const [a, b] = await Promise.all([replicaA.tick(), replicaB.tick()]);

    const expected = await activeAssetNetworkCount();
    expect(jobs.independentCalls).toHaveLength(expected);
    expect(new Set(jobs.independentCalls).size).toBe(expected); // no asset/network rescanned twice
    expect(jobs.collateralCallCount()).toBe(1);
    for (const key of Object.keys(a)) {
      // For each job, exactly one replica ran it and the other skipped it.
      expect([a[key], b[key]].sort()).toEqual(["ran", "skipped"]);
    }
  });

  it("a job another replica just finished is not re-run until intervalMs has elapsed (restart-safe: state is in the DB, not memory)", async () => {
    const jobs = countingJobs(0);
    await makeScheduler(jobs.independent, jobs.collateral).tick();
    const firstCount = jobs.independentCalls.length;

    // A brand-new instance (e.g. a restarted worker) sees the persisted lastStartedAt.
    const outcomes = await makeScheduler(jobs.independent, jobs.collateral).tick();
    expect(jobs.independentCalls).toHaveLength(firstCount);
    expect(Object.values(outcomes).every((o) => o === "skipped")).toBe(true);

    const rows = await prisma.scheduledJobState.findMany();
    expect(rows.every((r) => r.lockedAt === null && r.lockedBy === null && r.lastSuccessAt !== null)).toBe(true);
  });

  it("reclaims a crashed worker's stale lease, but never steals a live one", async () => {
    const jobs = countingJobs(0);
    const jobKey = "collateral-reconciliation";
    const longAgo = new Date(Date.now() - 10 * 3_600_000);

    // A live lease (fresh lockedAt) held by another worker: must be skipped.
    await prisma.scheduledJobState.create({ data: { jobKey, lockedAt: new Date(), lockedBy: "other-live-worker", lastStartedAt: longAgo } });
    let outcomes = await makeScheduler(jobs.independent, jobs.collateral).tick();
    expect(outcomes[jobKey]).toBe("skipped");
    expect(jobs.collateralCallCount()).toBe(0);

    // The same holder crashed long ago: its lease is stale and is reclaimed.
    await prisma.scheduledJobState.update({ where: { jobKey }, data: { lockedAt: longAgo } });
    outcomes = await makeScheduler(jobs.independent, jobs.collateral).tick();
    expect(outcomes[jobKey]).toBe("ran");
    expect(jobs.collateralCallCount()).toBe(1);
  });

  it("a failing job releases its lease, records the error, and is retried only after the interval — never hot-looped", async () => {
    const failing = {
      runIndependentRescan: async () => {
        throw new Error("rpc unavailable");
      },
    };
    const collateral = countingJobs(0).collateral;
    const outcomes = await makeScheduler(failing, collateral).tick();
    const failedKeys = Object.entries(outcomes).filter(([, o]) => o === "failed").map(([k]) => k);
    expect(failedKeys.length).toBe(await activeAssetNetworkCount());

    const row = await prisma.scheduledJobState.findUniqueOrThrow({ where: { jobKey: failedKeys[0] } });
    expect(row.lockedAt).toBeNull();
    expect(row.lastError).toBe("rpc unavailable");

    const again = await makeScheduler(failing, collateral).tick();
    expect(again[failedKeys[0]]).toBe("skipped");
  });
});

describe("Phase 35 — discrepancy de-duplication across repeated (scheduled) runs", () => {
  it("after a finding is resolved and recurs, repeated runs keep exactly ONE open row — never one more per run", async () => {
    const admin = await createTestSuperAdmin();
    const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");
    const failingAdapterFactory = {
      resolve: async () => {
        throw new Error(`rpc down ${assetNetwork.id}`);
      },
    };
    const noopProviderFactory = { resolve: async () => ({}) as CustodyProvider };
    const service = new IndependentReconciliationService(prisma, failingAdapterFactory as never, noopProviderFactory as never, auditLog);
    const openRows = () =>
      prisma.reconciliationDiscrepancy.findMany({
        where: { assetNetworkId: assetNetwork.id, type: "rescan_provider_error", status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      });

    await service.runIndependentRescan(assetNetwork.id, null);
    const [first] = await openRows();
    await service.resolve(first.id, admin.id, "RPC restored", "RESOLVED");

    // The same condition recurs on the next three scheduled runs.
    await service.runIndependentRescan(assetNetwork.id, null);
    await service.runIndependentRescan(assetNetwork.id, null);
    await service.runIndependentRescan(assetNetwork.id, null);

    expect(await openRows()).toHaveLength(1);
  });

  it("a scheduled (system-initiated) run is recorded as a SYSTEM actor with no initiating user", async () => {
    const assetNetwork = await getAssetNetwork("XRP", "xrpl-testnet");
    const adapter: BlockchainDepositAdapter = {
      family: "XRPL" as never,
      validateNetwork: async () => undefined,
      scanForDeposits: async () => ({ deposits: [], nextCursor: "x" }),
      inspectTransaction: async () => null,
    };
    const service = new IndependentReconciliationService(
      prisma,
      { resolve: async () => ({ adapter, network: {} }) } as never,
      { resolve: async () => ({}) } as never,
      auditLog,
    );

    const { run } = await service.runIndependentRescan(assetNetwork.id, null);
    expect(run.initiatedByUserId).toBeNull();
    const started = await prisma.auditLog.findFirst({
      where: { action: "reconciliation.independent_rescan_started", resourceId: assetNetwork.id },
      orderBy: { createdAt: "desc" },
    });
    expect(started?.actorType).toBe("SYSTEM");
  });
});

describe("Phase 35 — R1 stuck-withdrawal recovery (declareExecutionAmbiguous)", () => {
  function chainReports(status: ChainTransactionStatus["status"], extra: Partial<ChainTransactionStatus> = {}) {
    const provider: CustodyProvider = {
      getAddressBalance: async () => ({ address: "x", assetNetworkId: "x", balance: "0", asOf: new Date() }),
      getTransactionStatus: async (txHash, assetNetworkId) => ({ txHash, assetNetworkId, confirmations: 20, amount: "400", status, ...extra }),
    };
    return new WithdrawalsService(
      prisma,
      ledger,
      reservations,
      executorFactory,
      { resolve: async () => provider } as never,
      txRunner,
      auditLog,
      new ZeroWithdrawalFeeCalculator(),
      new DeferredComplianceGate(),
    );
  }

  async function broadcastWithdrawal(txHash: string) {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await withdrawalsService.request(user.id, {
      assetSymbol: "USDC",
      networkCode: "ethereum-sepolia",
      amount: "400",
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    await withdrawalsService.approve(withdrawal.id, admin.id);
    await withdrawalsService.recordManualBroadcast(withdrawal.id, admin.id, txHash);
    return { user, admin, withdrawal };
  }

  it("BROADCAST whose txHash the chain does not know: -> EXECUTION_AMBIGUOUS (funds still held, stale hash cleared), then evidence-based resolution with the CORRECT hash re-enters confirmation", async () => {
    const typo = `0xtypo${Date.now()}`;
    const { user, admin, withdrawal } = await broadcastWithdrawal(typo);
    const service = chainReports("not_found");

    const declared = await service.declareExecutionAmbiguous(withdrawal.id, admin.id, "admin mistyped the hash");
    expect(declared.status).toBe("EXECUTION_AMBIGUOUS");
    expect(declared.txHash).toBeNull();
    expect((await getUserAccount(user.id, "USDC"))?.reservedBalance.toString()).toBe("400"); // nothing released

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: withdrawal.id, action: "withdrawal.execution_declared_ambiguous" } });
    expect(audit.actorId).toBe(admin.id);
    expect((audit.before as Record<string, unknown>).txHash).toBe(typo);

    const corrected = await withdrawalsService.resolveAmbiguousExecution(
      withdrawal.id,
      admin.id,
      { outcome: "CONFIRMED_BROADCAST", txHash: `0xreal${Date.now()}` },
      "found the real hash in the wallet",
    );
    expect(corrected.status).toBe("BROADCAST");
    // Still not credited — only the watcher, on matching chain evidence, can do that.
    expect((await getUserAccount(user.id, "USDC"))?.cachedBalance.toString()).toBe("1000");
  });

  it("a never-broadcast withdrawal is only released through the attested NOT_EXECUTED path, exactly once", async () => {
    const { user, admin, withdrawal } = await broadcastWithdrawal(`0xdropped${Date.now()}`);
    await chainReports("not_found").declareExecutionAmbiguous(withdrawal.id, admin.id, "dropped from mempool; nonce reused by another tx");

    await withdrawalsService.resolveAmbiguousExecution(withdrawal.id, admin.id, { outcome: "CONFIRMED_NOT_EXECUTED" }, "nonce consumed elsewhere");
    await withdrawalsService.reject(withdrawal.id, "never executed", admin.id);
    await expect(withdrawalsService.reject(withdrawal.id, "again", admin.id)).rejects.toThrow(ConflictException);

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.reservedBalance.toString()).toBe("0");
    expect(account?.cachedBalance.toString()).toBe("1000");
  });

  it("REFUSES when the chain shows the transaction (confirmed or pending) — a real transfer may exist; no generic recovery", async () => {
    const { admin, withdrawal } = await broadcastWithdrawal(`0xexists${Date.now()}`);
    for (const status of ["confirmed", "pending", "failed"] as const) {
      await expect(chainReports(status).declareExecutionAmbiguous(withdrawal.id, admin.id, "try")).rejects.toThrow(ConflictException);
    }
    const current = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    expect(current.status).toBe("BROADCAST");
  });

  it("an abandoned BROADCASTING lease (worker died mid-execute) can be declared ambiguous; funds stay reserved", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await withdrawalsService.request(user.id, {
      assetSymbol: "USDC",
      networkCode: "ethereum-sepolia",
      amount: "250",
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    // Simulate a crash right after the execution-lease CAS.
    await prisma.withdrawal.update({ where: { id: withdrawal.id }, data: { status: "BROADCASTING" } });

    const declared = await chainReports("not_found").declareExecutionAmbiguous(withdrawal.id, admin.id, "worker OOM-killed during execute");
    expect(declared.status).toBe("EXECUTION_AMBIGUOUS");
    expect((await getUserAccount(user.id, "USDC"))?.reservedBalance.toString()).toBe("250");
  });

  it("refuses a PENDING_MANUAL_BROADCAST held by a custody provider, but allows a manual-executor one", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    const make = async () => {
      const w = await withdrawalsService.request(user.id, {
        assetSymbol: "USDC",
        networkCode: "ethereum-sepolia",
        amount: "100",
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
      });
      await withdrawalsService.approve(w.id, admin.id); // sandbox manual executor -> PENDING_MANUAL_BROADCAST
      return w;
    };
    const manual = await make();
    const providerHeld = await make();
    await prisma.withdrawal.update({ where: { id: providerHeld.id }, data: { custodyReference: "fb-tx-123" } });

    await expect(withdrawalsService.declareExecutionAmbiguous(providerHeld.id, admin.id, "stuck?")).rejects.toThrow(ConflictException);
    const declared = await withdrawalsService.declareExecutionAmbiguous(manual.id, admin.id, "approved in error; never broadcast");
    expect(declared.status).toBe("EXECUTION_AMBIGUOUS");
  });

  it("two SUPER_ADMINs declaring concurrently: exactly one succeeds", async () => {
    const { admin, withdrawal } = await broadcastWithdrawal(`0xrace${Date.now()}`);
    const service = chainReports("not_found");

    const results = await Promise.allSettled([
      service.declareExecutionAmbiguous(withdrawal.id, admin.id, "a"),
      service.declareExecutionAmbiguous(withdrawal.id, admin.id, "b"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("refuses a non-SUPER_ADMIN and terminal/non-stuck states", async () => {
    const { user, admin, withdrawal } = await broadcastWithdrawal(`0xauthz${Date.now()}`);
    await expect(chainReports("not_found").declareExecutionAmbiguous(withdrawal.id, user.id, "me")).rejects.toThrow(ForbiddenException);

    await withdrawalsService.recordConfirmation(withdrawal.id, 12, 12);
    await expect(chainReports("not_found").declareExecutionAmbiguous(withdrawal.id, admin.id, "too late")).rejects.toThrow(ConflictException);
  });
});

describe("Phase 35 — confirmation-mismatch audit de-duplication", () => {
  it("records ONE audit row per (withdrawal, txHash) however many watcher polls re-observe the mismatch", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await withdrawalsService.request(user.id, {
      assetSymbol: "USDC",
      networkCode: "ethereum-sepolia",
      amount: "300",
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    await withdrawalsService.approve(withdrawal.id, admin.id);
    await withdrawalsService.recordManualBroadcast(withdrawal.id, admin.id, `0xmismatch${Date.now()}`);

    for (let i = 0; i < 4; i++) {
      await withdrawalsService.recordConfirmation(withdrawal.id, 12, 12, { amount: "1", destinationAddress: "0x000000000000000000000000000000000000dEaD" });
    }

    const rows = await prisma.auditLog.findMany({ where: { resourceId: withdrawal.id, action: "withdrawal.confirmation_mismatch_refused" } });
    expect(rows).toHaveLength(1);
    const current = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    expect(current.status).not.toBe("CREDITED");
  });
});

describe("Phase 35 — scheduled reconciliation surfaces R1 mismatches in the discrepancy queue", () => {
  it("flags a BROADCAST withdrawal whose confirmed on-chain transfer paid the wrong amount as a CRITICAL discrepancy, without mutating it", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await withdrawalsService.request(user.id, {
      assetSymbol: "USDC",
      networkCode: "ethereum-sepolia",
      amount: "300",
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    await withdrawalsService.approve(withdrawal.id, admin.id);
    const txHash = `0xwrongamount${Date.now()}`;
    await withdrawalsService.recordManualBroadcast(withdrawal.id, admin.id, txHash);

    const provider: CustodyProvider = {
      getAddressBalance: async () => ({ address: "x", assetNetworkId: "x", balance: "0", asOf: new Date() }),
      getTransactionStatus: async (hash, assetNetworkId) => ({
        txHash: hash,
        assetNetworkId,
        confirmations: 20,
        amount: hash === txHash ? "299" : "0",
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
        status: hash === txHash ? "confirmed" : "not_found",
      }),
    };
    const service = new IndependentReconciliationService(
      prisma,
      { resolve: async () => ({ adapter: { scanForDeposits: async () => ({ deposits: [], nextCursor: "x" }) }, network: {} }) } as never,
      { resolve: async () => provider } as never,
      auditLog,
    );

    await service.runIndependentRescan(withdrawal.assetNetworkId, null);

    const finding = await prisma.reconciliationDiscrepancy.findFirst({ where: { type: "withdrawal_chain_mismatch", internalEntityId: withdrawal.id } });
    expect(finding?.severity).toBe("CRITICAL");
    expect(finding?.status).toBe("OPEN");
    const current = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    expect(current.status).toBe("BROADCAST");
    expect((await getUserAccount(user.id, "USDC"))?.reservedBalance.toString()).toBe("300");
  });
});
