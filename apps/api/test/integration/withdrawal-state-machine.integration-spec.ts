import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InsufficientBalanceError } from "../../src/ledger/ledger.errors";
import { CustodyProvider } from "../../src/wallet/custody/custody-provider.interface";
import { AuditLogService } from "../../src/audit/audit-log.service";
import { DeferredComplianceGate } from "../../src/wallet/withdrawals/compliance/deferred-compliance-gate";
import { ZeroWithdrawalFeeCalculator } from "../../src/wallet/withdrawals/fees/zero-withdrawal-fee.calculator";
import {
  auditLog,
  createTestSuperAdmin,
  createTestUser,
  executorFactory,
  fundUserForTest,
  getUserAccount,
  ledger,
  prisma,
  reservations,
  txRunner,
  withdrawalsService,
  WithdrawalsService,
} from "./helpers";

async function requestWithdrawal(userId: string, amount: string, overrides: { clientWithdrawalId?: string } = {}) {
  return withdrawalsService.request(userId, {
    assetSymbol: "USDC",
    networkCode: "ethereum-sepolia",
    amount,
    destinationAddress: "0x000000000000000000000000000000000000dEaD",
    ...overrides,
  });
}

describe("Withdrawal state machine (real Postgres)", () => {
  it("reserves funds on request without touching total balance", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "1000");

    const withdrawal = await requestWithdrawal(user.id, "200");
    expect(withdrawal.status).toBe("RISK_REVIEW");

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.cachedBalance.toString()).toBe("1000"); // untouched — nothing has left yet
    expect(account?.reservedBalance.toString()).toBe("200");
  });

  it("rejects a withdrawal request that exceeds available balance", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "100");

    await expect(requestWithdrawal(user.id, "150")).rejects.toThrow(InsufficientBalanceError);
  });

  it("blocks withdrawals for a non-ACTIVE (unverified) account", async () => {
    const user = await createTestUser("PENDING_VERIFICATION");
    await fundUserForTest(user.id, "USDC", "1000");

    await expect(requestWithdrawal(user.id, "100")).rejects.toThrow(ForbiddenException);
  });

  it("a second reservation cannot exceed what's left available after the first", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "100");

    await requestWithdrawal(user.id, "60");
    await expect(requestWithdrawal(user.id, "60")).rejects.toThrow(InsufficientBalanceError);
  });

  it("enforces a configured maxDailyWithdrawal limit — a previously dead RiskLimit field", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "1000");
    await prisma.riskLimit.create({ data: { userId: user.id, maxDailyWithdrawal: "250" } });

    await requestWithdrawal(user.id, "200");
    // 200 already requested in the trailing 24h + 100 more would be 300 > 250.
    await expect(requestWithdrawal(user.id, "100")).rejects.toThrow(BadRequestException);

    // Exactly at the remaining headroom (50) still succeeds.
    const third = await requestWithdrawal(user.id, "50");
    expect(third.status).toBe("RISK_REVIEW");
  });

  it("does not count a REJECTED withdrawal against the daily limit", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    await prisma.riskLimit.create({ data: { userId: user.id, maxDailyWithdrawal: "250" } });

    const first = await requestWithdrawal(user.id, "200");
    await withdrawalsService.reject(first.id, "risk flag", admin.id);

    // The rejected 200 never happened economically, so a fresh 200 request still fits under the 250 cap.
    const second = await requestWithdrawal(user.id, "200");
    expect(second.status).toBe("RISK_REVIEW");
  });

  it("leaves withdrawals unlimited when maxDailyWithdrawal is not configured (null = unlimited)", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "10000");

    await requestWithdrawal(user.id, "5000");
    const second = await requestWithdrawal(user.id, "4000");
    expect(second.status).toBe("RISK_REVIEW");
  });

  describe("idempotent creation (requirement #3)", () => {
    it("a duplicate clientWithdrawalId submitted sequentially returns the original withdrawal without re-reserving", async () => {
      const user = await createTestUser();
      await fundUserForTest(user.id, "USDC", "1000");

      const first = await requestWithdrawal(user.id, "200", { clientWithdrawalId: "fixed-key-1" });
      const second = await requestWithdrawal(user.id, "200", { clientWithdrawalId: "fixed-key-1" });

      expect(second.id).toBe(first.id);
      const account = await getUserAccount(user.id, "USDC");
      expect(account?.reservedBalance.toString()).toBe("200"); // reserved once, not twice
    });

    it("concurrent duplicate clientWithdrawalId submissions create exactly one withdrawal and reserve funds exactly once", async () => {
      const user = await createTestUser();
      await fundUserForTest(user.id, "USDC", "1000");

      const results = await Promise.all([
        requestWithdrawal(user.id, "300", { clientWithdrawalId: "concurrent-key" }),
        requestWithdrawal(user.id, "300", { clientWithdrawalId: "concurrent-key" }),
      ]);

      expect(results[0].id).toBe(results[1].id);
      const account = await getUserAccount(user.id, "USDC");
      expect(account?.reservedBalance.toString()).toBe("300");

      const rows = await prisma.withdrawal.findMany({ where: { userId: user.id, clientWithdrawalId: "concurrent-key" } });
      expect(rows).toHaveLength(1);
    });

    it("different clientWithdrawalIds for the same user create genuinely separate withdrawals", async () => {
      const user = await createTestUser();
      await fundUserForTest(user.id, "USDC", "1000");

      const a = await requestWithdrawal(user.id, "100", { clientWithdrawalId: "key-a" });
      const b = await requestWithdrawal(user.id, "100", { clientWithdrawalId: "key-b" });

      expect(a.id).not.toBe(b.id);
      const account = await getUserAccount(user.id, "USDC");
      expect(account?.reservedBalance.toString()).toBe("200");
    });
  });

  describe("compliance gate (requirement #14)", () => {
    it("records a DEFERRED compliance decision on every request — never silently 'approved'", async () => {
      const user = await createTestUser();
      await fundUserForTest(user.id, "USDC", "1000");

      const withdrawal = await requestWithdrawal(user.id, "100");
      expect(withdrawal.complianceDecision).toBe("DEFERRED");
      expect(withdrawal.complianceNote).toBeTruthy();
    });

    it("a BLOCKED decision stops the request before any reservation is created", async () => {
      const user = await createTestUser();
      await fundUserForTest(user.id, "USDC", "1000");

      const blockingGate = { assess: async () => ({ decision: "BLOCKED" as const, reason: "sanctioned destination" }) };
      const blockedService = new WithdrawalsService(
        prisma,
        ledger,
        reservations,
        executorFactory,
        { resolve: async () => ({}) } as never,
        txRunner,
        auditLog,
        new ZeroWithdrawalFeeCalculator(),
        blockingGate as never,
      );

      await expect(
        blockedService.request(user.id, {
          assetSymbol: "USDC",
          networkCode: "ethereum-sepolia",
          amount: "100",
          destinationAddress: "0x000000000000000000000000000000000000dEaD",
        } as never),
      ).rejects.toThrow(ForbiddenException);

      const account = await getUserAccount(user.id, "USDC");
      expect(account?.reservedBalance.toString()).toBe("0");
    });
  });

  describe("user-initiated cancellation (requirement #2, CANCELLED)", () => {
    it("releases the reservation and never allows access to another user's withdrawal", async () => {
      const user = await createTestUser();
      const stranger = await createTestUser();
      await fundUserForTest(user.id, "USDC", "1000");
      const withdrawal = await requestWithdrawal(user.id, "300");

      await expect(withdrawalsService.cancel(stranger.id, withdrawal.id)).rejects.toThrow(NotFoundException);

      const cancelled = await withdrawalsService.cancel(user.id, withdrawal.id);
      expect(cancelled.status).toBe("CANCELLED");

      const account = await getUserAccount(user.id, "USDC");
      expect(account?.reservedBalance.toString()).toBe("0");
      expect(account?.cachedBalance.toString()).toBe("1000");
    });

    it("cannot cancel a withdrawal that's already been approved — only reject() can from there", async () => {
      const user = await createTestUser();
      const admin = await createTestSuperAdmin();
      await fundUserForTest(user.id, "USDC", "1000");
      const withdrawal = await requestWithdrawal(user.id, "200");
      await withdrawalsService.approve(withdrawal.id, admin.id);

      await expect(withdrawalsService.cancel(user.id, withdrawal.id)).rejects.toThrow(ConflictException);
    });

    it("only one of two concurrent cancel() calls succeeds, releasing the reservation exactly once", async () => {
      const user = await createTestUser();
      await fundUserForTest(user.id, "USDC", "1000");
      const withdrawal = await requestWithdrawal(user.id, "300");

      const results = await Promise.allSettled([
        withdrawalsService.cancel(user.id, withdrawal.id),
        withdrawalsService.cancel(user.id, withdrawal.id),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

      const account = await getUserAccount(user.id, "USDC");
      expect(account?.reservedBalance.toString()).toBe("0");
    });
  });

  describe("SUPER_ADMIN authorization (requirement #15, #24)", () => {
    it("approve() rejects an ordinary USER, even though they own the withdrawal", async () => {
      const user = await createTestUser();
      await fundUserForTest(user.id, "USDC", "1000");
      const withdrawal = await requestWithdrawal(user.id, "200");

      await expect(withdrawalsService.approve(withdrawal.id, user.id)).rejects.toThrow(ForbiddenException);
    });

    it("approve() rejects a plain ADMIN — ADMIN never automatically inherits SUPER_ADMIN financial control", async () => {
      const user = await createTestUser();
      const admin = await createTestUser("ACTIVE", "ADMIN");
      await fundUserForTest(user.id, "USDC", "1000");
      const withdrawal = await requestWithdrawal(user.id, "200");

      await expect(withdrawalsService.approve(withdrawal.id, admin.id)).rejects.toThrow(ForbiddenException);
      await expect(withdrawalsService.reject(withdrawal.id, "no", admin.id)).rejects.toThrow(ForbiddenException);

      const stillPending = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
      expect(stillPending.status).toBe("RISK_REVIEW");
    });

    it("reconcile() rejects a plain ADMIN — read-only reconciliation is still SUPER_ADMIN-only", async () => {
      const admin = await createTestUser("ACTIVE", "ADMIN");
      const user = await createTestUser();
      await fundUserForTest(user.id, "USDC", "1000");
      const withdrawal = await requestWithdrawal(user.id, "200");

      await expect(withdrawalsService.reconcile(withdrawal.id, admin.id)).rejects.toThrow(ForbiddenException);
    });
  });

  it("only one of two concurrent approve() calls succeeds; the executor is invoked exactly once", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await requestWithdrawal(user.id, "300");

    const results = await Promise.allSettled([
      withdrawalsService.approve(withdrawal.id, admin.id),
      withdrawalsService.approve(withdrawal.id, admin.id),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);

    const final = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    expect(final.status).toBe("PENDING_MANUAL_BROADCAST"); // sandbox default executor
  });

  it("only one of two concurrent reject() calls succeeds, and the hold is released exactly once", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await requestWithdrawal(user.id, "300");

    const results = await Promise.allSettled([
      withdrawalsService.reject(withdrawal.id, "risk flag A", admin.id),
      withdrawalsService.reject(withdrawal.id, "risk flag B", admin.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const account = await getUserAccount(user.id, "USDC");
    // Released exactly once: reservedBalance back to 0, not negative
    // (which double-release would produce), and total balance untouched.
    expect(account?.reservedBalance.toString()).toBe("0");
    expect(account?.cachedBalance.toString()).toBe("1000");
  });

  it("approve vs reject race: exactly one wins, never both", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await requestWithdrawal(user.id, "300");

    const results = await Promise.allSettled([
      withdrawalsService.approve(withdrawal.id, admin.id),
      withdrawalsService.reject(withdrawal.id, "risk flag", admin.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const final = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    const account = await getUserAccount(user.id, "USDC");
    if (final.status === "REJECTED") {
      expect(account?.reservedBalance.toString()).toBe("0");
    } else {
      expect(final.status).toBe("PENDING_MANUAL_BROADCAST");
      expect(account?.reservedBalance.toString()).toBe("300"); // still held — not yet confirmed
    }
  });

  it("only one of two concurrent fail() calls succeeds, releasing the hold exactly once", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "500");
    const withdrawal = await requestWithdrawal(user.id, "200");
    await withdrawalsService.approve(withdrawal.id, admin.id); // -> PENDING_MANUAL_BROADCAST

    const results = await Promise.allSettled([
      withdrawalsService.fail(withdrawal.id, "broadcast failed A"),
      withdrawalsService.fail(withdrawal.id, "broadcast failed B"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.reservedBalance.toString()).toBe("0");
    expect(account?.cachedBalance.toString()).toBe("500");
  });

  it("full happy path: request -> approve -> manual broadcast -> confirm actually moves total balance exactly once", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await requestWithdrawal(user.id, "400");

    await withdrawalsService.approve(withdrawal.id, admin.id);
    await withdrawalsService.recordManualBroadcast(withdrawal.id, admin.id, "0xrealtxhash");
    await withdrawalsService.recordConfirmation(withdrawal.id, 3, 12); // not enough yet
    let current = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    expect(current.status).toBe("CONFIRMING");

    const accountMidway = await getUserAccount(user.id, "USDC");
    expect(accountMidway?.cachedBalance.toString()).toBe("1000"); // still untouched

    await withdrawalsService.recordConfirmation(withdrawal.id, 12, 12);
    current = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
    expect(current.status).toBe("CREDITED");

    const accountFinal = await getUserAccount(user.id, "USDC");
    expect(accountFinal?.cachedBalance.toString()).toBe("600"); // 1000 - 400, moved exactly once
    expect(accountFinal?.reservedBalance.toString()).toBe("0");

    // Every transition is auditable: request (user), confirm (system).
    // "withdrawal.approve"/"withdrawal.manual_broadcast" are logged by
    // AdminController in production (this test calls the service
    // directly, bypassing that layer — see the unit tests for
    // "withdrawal.broadcast", which only fires on the OTHER approve()
    // branch, when an executor itself reports a real broadcast).
    const auditRows = await prisma.auditLog.findMany({
      where: { resourceType: "Withdrawal", resourceId: withdrawal.id },
      orderBy: { createdAt: "asc" },
    });
    expect(auditRows.map((r) => r.action)).toEqual(["withdrawal.request", "withdrawal.confirmed"]);
    expect(auditRows[0].actorType).toBe("USER");
    expect(auditRows[0].actorId).toBe(user.id);
    expect(auditRows[1].actorType).toBe("SYSTEM");
  });

  it("concurrent duplicate confirmation calls do not double-debit the balance", async () => {
    const user = await createTestUser();
    const admin = await createTestSuperAdmin();
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await requestWithdrawal(user.id, "400");
    await withdrawalsService.approve(withdrawal.id, admin.id);
    await withdrawalsService.recordManualBroadcast(withdrawal.id, admin.id, "0xrealtxhash2");

    await Promise.allSettled(
      Array.from({ length: 6 }, () => withdrawalsService.recordConfirmation(withdrawal.id, 12, 12)),
    );

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.cachedBalance.toString()).toBe("600"); // debited exactly once, not six times

    const asset = await prisma.asset.findUniqueOrThrow({ where: { symbol: "USDC" } });
    const txns = await prisma.ledgerTransaction.findMany({
      where: { assetId: asset.id, referenceType: "Withdrawal", referenceId: withdrawal.id, type: "WITHDRAWAL" },
    });
    expect(txns).toHaveLength(1);
  });

  describe("fee-aware ledger posting (requirement #12)", () => {
    it("posts a 3-leg transaction crediting FEE_REVENUE, and the user is still debited exactly the full requested amount", async () => {
      const user = await createTestUser();
      const admin = await createTestSuperAdmin();
      await fundUserForTest(user.id, "USDC", "1000");

      const flatFeeGate = new DeferredComplianceGate();
      const flatFeeCalculator = { calculateWithdrawalFee: () => ({ fee: new Prisma.Decimal("5") }) };
      const feeAwareService = new WithdrawalsService(
        prisma,
        ledger,
        reservations,
        executorFactory,
        { resolve: async () => ({}) } as never,
        txRunner,
        auditLog,
        flatFeeCalculator as never,
        flatFeeGate,
      );

      const withdrawal = await feeAwareService.request(user.id, {
        assetSymbol: "USDC",
        networkCode: "ethereum-sepolia",
        amount: "100",
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
      } as never);
      expect(withdrawal.fee.toString()).toBe("5");

      // Reservation is still exactly `amount` (100), not amount+fee.
      const midway = await getUserAccount(user.id, "USDC");
      expect(midway?.reservedBalance.toString()).toBe("100");

      await feeAwareService.approve(withdrawal.id, admin.id);
      await feeAwareService.recordManualBroadcast(withdrawal.id, admin.id, "0xfeetest");
      await feeAwareService.recordConfirmation(withdrawal.id, 12, 12);

      const final = await getUserAccount(user.id, "USDC");
      expect(final?.cachedBalance.toString()).toBe("900"); // 1000 - 100, the full requested amount
      expect(final?.reservedBalance.toString()).toBe("0");

      const usdcAsset = await prisma.asset.findUniqueOrThrow({ where: { symbol: "USDC" } });
      // Scoped by assetId, not just houseAccountKey — LedgerAccount is
      // unique on (houseAccountKey, assetId) (one FEE_REVENUE account PER
      // asset), and other tests in this suite post fees for other assets
      // to the same houseAccountKey, so an unscoped findFirst() can
      // nondeterministically return a different asset's account.
      const feeAccount = await prisma.ledgerAccount.findFirst({ where: { houseAccountKey: "FEE_REVENUE", assetId: usdcAsset.id } });
      expect(feeAccount?.cachedBalance.toString()).toBe("5");
    });
  });

  describe("reconcile (requirement #18, #21) — read + audit only, never mutates", () => {
    it("flags a discrepancy when internal state claims broadcast but the chain reports not_found, without touching the withdrawal", async () => {
      const user = await createTestUser();
      const admin = await createTestSuperAdmin();
      await fundUserForTest(user.id, "USDC", "1000");
      const withdrawal = await requestWithdrawal(user.id, "200");
      await withdrawalsService.approve(withdrawal.id, admin.id);
      await withdrawalsService.recordManualBroadcast(withdrawal.id, admin.id, "0xghost");

      const fakeProvider: CustodyProvider = {
        getAddressBalance: async () => ({ address: "irrelevant", assetNetworkId: "an", balance: "0", asOf: new Date() }),
        getTransactionStatus: async () => ({ txHash: "0xghost", assetNetworkId: "an", confirmations: 0, amount: "0", status: "not_found" }),
      };
      const reconcilingService = new WithdrawalsService(
        prisma,
        ledger,
        reservations,
        executorFactory,
        { resolve: async () => fakeProvider } as never,
        txRunner,
        new AuditLogService(prisma),
        new ZeroWithdrawalFeeCalculator(),
        new DeferredComplianceGate(),
      );

      const report = await reconcilingService.reconcile(withdrawal.id, admin.id);

      expect(report.discrepancy).toBe(true);
      const stillBroadcast = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
      expect(stillBroadcast.status).toBe("BROADCAST"); // untouched by reconcile — a human must decide
      const account = await getUserAccount(user.id, "USDC");
      expect(account?.reservedBalance.toString()).toBe("200"); // reservation untouched too

      const auditRows = await prisma.auditLog.findMany({ where: { resourceType: "Withdrawal", resourceId: withdrawal.id, action: "withdrawal.reconcile" } });
      expect(auditRows).toHaveLength(1);
    });

    it("reports no discrepancy when the chain confirms what internal state already expects", async () => {
      const user = await createTestUser();
      const admin = await createTestSuperAdmin();
      await fundUserForTest(user.id, "USDC", "1000");
      const withdrawal = await requestWithdrawal(user.id, "200");
      await withdrawalsService.approve(withdrawal.id, admin.id);
      await withdrawalsService.recordManualBroadcast(withdrawal.id, admin.id, "0xreal");

      const fakeProvider: CustodyProvider = {
        getAddressBalance: async () => ({ address: "irrelevant", assetNetworkId: "an", balance: "0", asOf: new Date() }),
        getTransactionStatus: async () => ({ txHash: "0xreal", assetNetworkId: "an", confirmations: 6, amount: "200", status: "confirmed" }),
      };
      const reconcilingService = new WithdrawalsService(
        prisma,
        ledger,
        reservations,
        executorFactory,
        { resolve: async () => fakeProvider } as never,
        txRunner,
        new AuditLogService(prisma),
        new ZeroWithdrawalFeeCalculator(),
        new DeferredComplianceGate(),
      );

      const report = await reconcilingService.reconcile(withdrawal.id, admin.id);
      expect(report.discrepancy).toBe(false);
    });
  });
});
