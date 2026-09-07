import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { InsufficientBalanceError } from "../../src/ledger/ledger.errors";
import { createTestUser, fundUserForTest, getUserAccount, prisma, withdrawalsService } from "./helpers";

async function requestWithdrawal(userId: string, amount: string) {
  return withdrawalsService.request(userId, {
    assetSymbol: "USDC",
    networkCode: "ethereum-sepolia",
    amount,
    destinationAddress: "0x000000000000000000000000000000000000dEaD",
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
    await fundUserForTest(user.id, "USDC", "1000");
    await prisma.riskLimit.create({ data: { userId: user.id, maxDailyWithdrawal: "250" } });

    const first = await requestWithdrawal(user.id, "200");
    await withdrawalsService.reject(first.id, "risk flag");

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

  it("only one of two concurrent approve() calls succeeds; the executor is invoked exactly once", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await requestWithdrawal(user.id, "300");

    const results = await Promise.allSettled([
      withdrawalsService.approve(withdrawal.id),
      withdrawalsService.approve(withdrawal.id),
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
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await requestWithdrawal(user.id, "300");

    const results = await Promise.allSettled([
      withdrawalsService.reject(withdrawal.id, "risk flag A"),
      withdrawalsService.reject(withdrawal.id, "risk flag B"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const account = await getUserAccount(user.id, "USDC");
    // Released exactly once: reservedBalance back to 0, not negative
    // (which double-release would produce), and total balance untouched.
    expect(account?.reservedBalance.toString()).toBe("0");
    expect(account?.cachedBalance.toString()).toBe("1000");
  });

  it("only one of two concurrent fail() calls succeeds, releasing the hold exactly once", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "500");
    const withdrawal = await requestWithdrawal(user.id, "200");
    await withdrawalsService.approve(withdrawal.id); // -> PENDING_MANUAL_BROADCAST

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
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await requestWithdrawal(user.id, "400");

    await withdrawalsService.approve(withdrawal.id);
    await withdrawalsService.recordManualBroadcast(withdrawal.id, "admin-1", "0xrealtxhash");
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
    await fundUserForTest(user.id, "USDC", "1000");
    const withdrawal = await requestWithdrawal(user.id, "400");
    await withdrawalsService.approve(withdrawal.id);
    await withdrawalsService.recordManualBroadcast(withdrawal.id, "admin-1", "0xrealtxhash2");

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
});
