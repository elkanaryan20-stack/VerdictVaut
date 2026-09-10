import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { AuditLogService } from "../../audit/audit-log.service";
import { LedgerService } from "../../ledger/ledger.service";
import { ReservationService } from "../../ledger/reservation.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";
import { CustodyProviderFactory } from "../custody/custody-provider.factory";
import { WithdrawalExecutorFactory } from "../executors/withdrawal-executor.factory";
import { WithdrawalComplianceGate } from "./compliance/withdrawal-compliance-gate.interface";
import { RequestWithdrawalDto } from "./dto/request-withdrawal.dto";
import { WithdrawalFeeCalculator } from "./fees/withdrawal-fee-calculator.interface";
import { WithdrawalsService } from "./withdrawals.service";

function makeIdempotencyConflict() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
    meta: { target: ["userId", "clientWithdrawalId"] },
  });
}

describe("WithdrawalsService", () => {
  let service: WithdrawalsService;
  let prisma: {
    $executeRawUnsafe: jest.Mock;
    user: { findUniqueOrThrow: jest.Mock; findUnique: jest.Mock };
    asset: { findUnique: jest.Mock };
    network: { findUnique: jest.Mock };
    assetNetwork: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    riskLimit: { findUnique: jest.Mock };
    withdrawal: {
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
    };
  };
  let ledger: { postTransaction: jest.Mock };
  let reservations: { reserve: jest.Mock; release: jest.Mock; capture: jest.Mock; findActiveByReference: jest.Mock };
  let executorFactory: { resolve: jest.Mock };
  let custodyProviderFactory: { resolve: jest.Mock };
  let txRunner: { run: jest.Mock };
  let auditLog: { record: jest.Mock };
  let feeCalculator: { calculateWithdrawalFee: jest.Mock };
  let complianceGate: { assess: jest.Mock };
  // Simulates Prisma returning the FULL row (not just the updated
  // columns) from update()/updateMany()+re-read — real Postgres/Prisma
  // always does this; spreading only `data` would silently drop fields
  // like amount/fee that a later `.toString()` call in the service
  // legitimately expects, and would make a SECOND transition (e.g.
  // approve()'s APPROVED -> BROADCAST call, after its own APPROVED ->
  // ... call) forget the first transition's effect.
  let lastRow: Record<string, unknown> | undefined;
  function ensureRow(id: string) {
    if (!lastRow) {
      lastRow = {
        id,
        userId: "user-1",
        assetNetworkId: "an-1",
        status: "RISK_REVIEW",
        amount: new Prisma.Decimal(100),
        fee: new Prisma.Decimal(0),
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
        destinationTag: null,
        txHash: null,
      };
    }
  }

  const asset = { id: "asset-1", symbol: "USDC" };
  const network = { id: "network-1", code: "ethereum-sepolia", family: "EVM" };
  const assetNetwork = { id: "an-1", assetId: "asset-1", networkId: "network-1", isActive: true, withdrawalMinAmount: new Prisma.Decimal(0), memoRequired: false };

  const dto = (overrides: Partial<RequestWithdrawalDto> = {}): RequestWithdrawalDto =>
    ({
      assetSymbol: "USDC",
      networkCode: "ethereum-sepolia",
      amount: "100",
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
      ...overrides,
    }) as RequestWithdrawalDto;

  beforeEach(() => {
    lastRow = undefined;
    prisma = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "user-1", status: "ACTIVE" }),
        findUnique: jest.fn().mockResolvedValue({ id: "admin-1", role: "SUPER_ADMIN" }),
      },
      asset: { findUnique: jest.fn().mockResolvedValue(asset) },
      network: { findUnique: jest.fn().mockResolvedValue(network) },
      assetNetwork: {
        findUnique: jest.fn().mockResolvedValue(assetNetwork),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ ...assetNetwork, asset }),
      },
      riskLimit: { findUnique: jest.fn().mockResolvedValue(null) },
      withdrawal: {
        create: jest.fn().mockImplementation(async ({ data }) => {
          lastRow = { id: "wd-1", status: "REQUESTED", ...data };
          return lastRow;
        }),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          ensureRow(where.id);
          lastRow = { ...lastRow, ...data };
          return lastRow;
        }),
        updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
          ensureRow(where.id);
          lastRow = { ...lastRow, ...data };
          return { count: 1 };
        }),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockImplementation(async ({ where }: { where: { id?: string } }) => {
          ensureRow(where?.id ?? "wd-1");
          return lastRow!;
        }),
      },
    };
    ledger = { postTransaction: jest.fn().mockResolvedValue({ transactionId: "ltx-1", alreadyPosted: false }) };
    reservations = {
      reserve: jest.fn().mockResolvedValue({ reservationId: "res-1", alreadyReserved: false }),
      release: jest.fn(),
      capture: jest.fn(),
      findActiveByReference: jest.fn().mockResolvedValue({ id: "res-1" }),
    };
    executorFactory = { resolve: jest.fn() };
    custodyProviderFactory = { resolve: jest.fn() };
    txRunner = { run: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)) };
    auditLog = { record: jest.fn().mockResolvedValue({}) };
    feeCalculator = { calculateWithdrawalFee: jest.fn().mockReturnValue({ fee: new Prisma.Decimal(0) }) };
    complianceGate = { assess: jest.fn().mockResolvedValue({ decision: "DEFERRED", reason: "no system wired up" }) };

    service = new WithdrawalsService(
      prisma as unknown as PrismaService,
      ledger as unknown as LedgerService,
      reservations as unknown as ReservationService,
      executorFactory as unknown as WithdrawalExecutorFactory,
      custodyProviderFactory as unknown as CustodyProviderFactory,
      txRunner as unknown as SerializableTransactionRunner,
      auditLog as unknown as AuditLogService,
      feeCalculator as unknown as WithdrawalFeeCalculator,
      complianceGate as unknown as WithdrawalComplianceGate,
    );
  });

  describe("request", () => {
    it("rejects a non-ACTIVE account", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: "user-1", status: "PENDING_VERIFICATION" });
      await expect(service.request("user-1", dto())).rejects.toThrow(ForbiddenException);
      expect(reservations.reserve).not.toHaveBeenCalled();
    });

    it("rejects an unknown asset/network", async () => {
      prisma.asset.findUnique.mockResolvedValue(null);
      await expect(service.request("user-1", dto())).rejects.toThrow(BadRequestException);
    });

    it("rejects an amount at or below the configured minimum", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ ...assetNetwork, withdrawalMinAmount: new Prisma.Decimal(100) });
      await expect(service.request("user-1", dto({ amount: "100" }))).rejects.toThrow(BadRequestException);
    });

    it("rejects a missing destination tag when the network requires one", async () => {
      prisma.assetNetwork.findUnique.mockResolvedValue({ ...assetNetwork, memoRequired: true });
      await expect(service.request("user-1", dto())).rejects.toThrow(BadRequestException);
    });

    it("rejects a malformed destination address for the network family", async () => {
      await expect(service.request("user-1", dto({ destinationAddress: "not-a-real-address" }))).rejects.toThrow(BadRequestException);
    });

    it("rejects when the configured fee would consume the entire amount", async () => {
      feeCalculator.calculateWithdrawalFee.mockReturnValue({ fee: new Prisma.Decimal(100) });
      await expect(service.request("user-1", dto({ amount: "100" }))).rejects.toThrow(BadRequestException);
      expect(reservations.reserve).not.toHaveBeenCalled();
    });

    it("reserves exactly `amount` (not amount + fee) and records the fee on the row", async () => {
      feeCalculator.calculateWithdrawalFee.mockReturnValue({ fee: new Prisma.Decimal(1) });
      await service.request("user-1", dto({ amount: "100" }));

      expect(reservations.reserve).toHaveBeenCalledWith(prisma, expect.objectContaining({ amount: expect.objectContaining({ d: [100] }) }));
      expect(prisma.withdrawal.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ fee: expect.any(Prisma.Decimal) }) }),
      );
    });

    it("always assesses compliance and records the decision on the withdrawal, even when DEFERRED", async () => {
      complianceGate.assess.mockResolvedValue({ decision: "DEFERRED", reason: "no KYC system yet" });
      await service.request("user-1", dto());

      expect(complianceGate.assess).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1", assetSymbol: "USDC", networkCode: "ethereum-sepolia" }),
      );
      expect(prisma.withdrawal.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ complianceDecision: "DEFERRED", complianceNote: "no KYC system yet" }) }),
      );
    });

    it("blocks the request outright when compliance decides BLOCKED, and never reserves funds", async () => {
      complianceGate.assess.mockResolvedValue({ decision: "BLOCKED", reason: "sanctioned destination" });
      await expect(service.request("user-1", dto())).rejects.toThrow(ForbiddenException);
      expect(prisma.withdrawal.create).not.toHaveBeenCalled();
      expect(reservations.reserve).not.toHaveBeenCalled();
    });

    it("enforces a configured maxDailyWithdrawal, summing non-REJECTED/FAILED withdrawals in the same asset over the trailing 24h", async () => {
      prisma.riskLimit.findUnique.mockResolvedValue({ maxDailyWithdrawal: new Prisma.Decimal(150) });
      prisma.withdrawal.findMany.mockResolvedValue([{ amount: new Prisma.Decimal(100) }]);

      await expect(service.request("user-1", dto({ amount: "100" }))).rejects.toThrow(BadRequestException);
      expect(reservations.reserve).not.toHaveBeenCalled();
    });

    it("excludes CANCELLED (never happened economically) from the daily-limit running total, alongside REJECTED/FAILED", async () => {
      prisma.riskLimit.findUnique.mockResolvedValue({ maxDailyWithdrawal: new Prisma.Decimal(150) });
      prisma.withdrawal.findMany.mockResolvedValue([]);

      await service.request("user-1", dto({ amount: "100" }));

      expect(prisma.withdrawal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: { notIn: ["REJECTED", "FAILED", "CANCELLED"] } }) }),
      );
    });

    it("allows the request when under the daily limit", async () => {
      prisma.riskLimit.findUnique.mockResolvedValue({ maxDailyWithdrawal: new Prisma.Decimal(150) });
      prisma.withdrawal.findMany.mockResolvedValue([{ amount: new Prisma.Decimal(40) }]);

      await expect(service.request("user-1", dto({ amount: "100" }))).resolves.toBeDefined();
    });

    it("is idempotent: a duplicate clientWithdrawalId returns the existing withdrawal without re-reserving", async () => {
      prisma.withdrawal.create.mockRejectedValue(makeIdempotencyConflict());
      prisma.withdrawal.findUniqueOrThrow.mockResolvedValue({ id: "wd-existing", status: "RISK_REVIEW", amount: new Prisma.Decimal(100), fee: new Prisma.Decimal(0) });

      const result = await service.request("user-1", dto({ clientWithdrawalId: "fixed-key" }));

      expect(result.id).toBe("wd-existing");
      expect(reservations.reserve).not.toHaveBeenCalled();
    });
  });

  describe("getOwned", () => {
    it("throws NotFound (never Forbidden) for a withdrawal owned by someone else — never confirms it exists", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", userId: "someone-else" });
      await expect(service.getOwned("user-1", "wd-1")).rejects.toThrow(NotFoundException);
    });

    it("returns the withdrawal for its real owner", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", userId: "user-1" });
      await expect(service.getOwned("user-1", "wd-1")).resolves.toEqual({ id: "wd-1", userId: "user-1" });
    });
  });

  describe("cancel", () => {
    it("rejects cancelling someone else's withdrawal with NotFound", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", userId: "someone-else", status: "RISK_REVIEW" });
      await expect(service.cancel("user-1", "wd-1")).rejects.toThrow(NotFoundException);
    });

    it("releases the reservation and transitions to CANCELLED for the real owner", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", userId: "user-1", status: "RISK_REVIEW" });
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });

      await service.cancel("user-1", "wd-1");

      expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: "wd-1" }), data: { status: "CANCELLED" } }),
      );
      expect(reservations.release).toHaveBeenCalledWith(prisma, "res-1");
    });

    it("rejects cancelling an already-APPROVED withdrawal (past the user's own control)", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", userId: "user-1", status: "APPROVED" });
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.cancel("user-1", "wd-1")).rejects.toThrow(ConflictException);
    });
  });

  describe("approve / reject authorization", () => {
    it("approve() rejects a non-SUPER_ADMIN actor before touching the withdrawal", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
      await expect(service.approve("wd-1", "admin-1")).rejects.toThrow(ForbiddenException);
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    });

    it("reject() rejects a non-SUPER_ADMIN actor before touching the withdrawal", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
      await expect(service.reject("wd-1", "reason", "admin-1")).rejects.toThrow(ForbiddenException);
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    });

    it("approve() rejects an unknown actor id", async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.approve("wd-1", "ghost")).rejects.toThrow(ForbiddenException);
    });
  });

  describe("approve — broadcast safety", () => {
    const approvedWithdrawal = {
      id: "wd-1",
      userId: "user-1",
      assetNetworkId: "an-1",
      status: "APPROVED",
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
      destinationTag: null,
      amount: new Prisma.Decimal(100),
      fee: new Prisma.Decimal(0),
    };

    it("threads a manual-broadcast executor's result into PENDING_MANUAL_BROADCAST, carrying custodyReference", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(approvedWithdrawal);
      executorFactory.resolve.mockResolvedValue({ execute: jest.fn().mockResolvedValue({ status: "awaiting_manual_broadcast", providerReference: "ref-1" }) });

      await service.approve("wd-1", "admin-1");

      expect(prisma.withdrawal.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "PENDING_MANUAL_BROADCAST", custodyReference: "ref-1" }) }),
      );
    });

    it("transitions to BROADCAST and records a distinct audit event when the executor reports a real broadcast", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(approvedWithdrawal);
      executorFactory.resolve.mockResolvedValue({ execute: jest.fn().mockResolvedValue({ status: "broadcast", txHash: "0xabc", providerReference: "ref-2" }) });

      const result = await service.approve("wd-1", "admin-1");

      expect(result).toMatchObject({ status: "BROADCAST", txHash: "0xabc" });
      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: "withdrawal.broadcast", after: expect.objectContaining({ txHash: "0xabc" }) }));
    });

    it("moves to EXECUTION_AMBIGUOUS (never a blind retry) when the executor reports an ambiguous outcome, and audit-logs the reason", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(approvedWithdrawal);
      executorFactory.resolve.mockResolvedValue({
        execute: jest.fn().mockResolvedValue({ status: "ambiguous", providerReference: "ref-3", reason: "provider request timed out after submission" }),
      });

      const result = await service.approve("wd-1", "admin-1");

      expect(result).toMatchObject({ status: "EXECUTION_AMBIGUOUS", custodyReference: "ref-3" });
      // The BROADCASTING execution lease is never reverted back to
      // APPROVED on an ambiguous result — only the initial RISK_REVIEW ->
      // APPROVED step (an unrelated, earlier part of approve()) sets
      // APPROVED; reverting the lease itself would invite a blind retry.
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { in: ["BROADCASTING"] } }),
          data: expect.objectContaining({ status: "APPROVED" }),
        }),
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "withdrawal.execution_ambiguous", reason: "provider request timed out after submission" }),
      );
    });

    it("never calls the executor when the CAS to APPROVED fails (already approved/terminal) — no blind re-execution", async () => {
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", status: "APPROVED" });

      await expect(service.approve("wd-1", "admin-1")).rejects.toThrow(ConflictException);
      expect(executorFactory.resolve).not.toHaveBeenCalled();
    });

    it("acquires a BROADCASTING execution lease before ever calling the executor, so reject() (valid from APPROVED) cannot race an in-flight broadcast", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(approvedWithdrawal);
      const execute = jest.fn().mockResolvedValue({ status: "awaiting_manual_broadcast" });
      executorFactory.resolve.mockResolvedValue({ execute });

      await service.approve("wd-1", "admin-1");

      const leaseCallIndex = prisma.withdrawal.updateMany.mock.calls.findIndex(([args]) => args.data.status === "BROADCASTING");
      expect(leaseCallIndex).toBeGreaterThanOrEqual(0);
      const leaseCallOrder = prisma.withdrawal.updateMany.mock.invocationCallOrder[leaseCallIndex];
      expect(leaseCallOrder).toBeLessThan(execute.mock.invocationCallOrder[0]);
    });

    it("never calls the executor when the execution-lease CAS itself loses the race (e.g. reject() already won right after the RISK_REVIEW->APPROVED step)", async () => {
      let call = 0;
      prisma.withdrawal.updateMany.mockImplementation(async ({ data }) => {
        call += 1;
        if (call === 2) return { count: 0 };
        lastRow = { ...(lastRow ?? { id: "wd-1", status: "RISK_REVIEW" }), ...data };
        return { count: 1 };
      });
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", status: "REJECTED" });

      await expect(service.approve("wd-1", "admin-1")).rejects.toThrow(ConflictException);
      expect(executorFactory.resolve).not.toHaveBeenCalled();
    });

    it("releases the execution lease back to APPROVED and rethrows the original error when the executor throws — reject() becomes reachable again from there", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue(approvedWithdrawal);
      const boom = new Error("custody provider unreachable");
      executorFactory.resolve.mockResolvedValue({ execute: jest.fn().mockRejectedValue(boom) });

      await expect(service.approve("wd-1", "admin-1")).rejects.toThrow("custody provider unreachable");

      expect(prisma.withdrawal.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { in: ["BROADCASTING"] } }),
          data: expect.objectContaining({ status: "APPROVED" }),
        }),
      );
    });
  });

  describe("resolveAmbiguousExecution", () => {
    it("requires SUPER_ADMIN", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
      await expect(
        service.resolveAmbiguousExecution("wd-1", "admin-1", { outcome: "CONFIRMED_NOT_EXECUTED" }, "checked with provider"),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    });

    it("CONFIRMED_BROADCAST moves EXECUTION_AMBIGUOUS -> BROADCAST with the admin-supplied txHash, never fabricating one", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", status: "EXECUTION_AMBIGUOUS" });

      const result = await service.resolveAmbiguousExecution(
        "wd-1",
        "admin-1",
        { outcome: "CONFIRMED_BROADCAST", txHash: "0xrealtxhash" },
        "Confirmed via Fireblocks dashboard directly",
      );

      expect(result).toMatchObject({ status: "BROADCAST", txHash: "0xrealtxhash" });
      expect(prisma.withdrawal.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { in: ["EXECUTION_AMBIGUOUS"] } }),
          data: expect.objectContaining({ status: "BROADCAST", txHash: "0xrealtxhash" }),
        }),
      );
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "withdrawal.ambiguous_execution_resolved", reason: "Confirmed via Fireblocks dashboard directly" }),
      );
    });

    it("CONFIRMED_NOT_EXECUTED moves EXECUTION_AMBIGUOUS -> APPROVED, safe for a retry or a subsequent reject()", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", status: "EXECUTION_AMBIGUOUS" });

      const result = await service.resolveAmbiguousExecution(
        "wd-1",
        "admin-1",
        { outcome: "CONFIRMED_NOT_EXECUTED" },
        "Provider has no record of this idempotency key",
      );

      expect(result).toMatchObject({ status: "APPROVED" });
    });

    it("refuses to resolve a withdrawal that isn't actually EXECUTION_AMBIGUOUS", async () => {
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", status: "BROADCAST" });

      await expect(
        service.resolveAmbiguousExecution("wd-1", "admin-1", { outcome: "CONFIRMED_NOT_EXECUTED" }, "notes"),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("recordConfirmation — fee-aware ledger posting", () => {
    it("posts a 2-leg transaction (no FEE_REVENUE) when the withdrawal has zero fee", async () => {
      await service.recordConfirmation("wd-1", 12, 12);

      const postings = ledger.postTransaction.mock.calls[0][1].postings;
      expect(postings).toHaveLength(2);
      expect(postings.find((p: { account: { key?: string } }) => p.account.key === "FEE_REVENUE")).toBeUndefined();
    });

    it("posts a 3-leg transaction crediting FEE_REVENUE when the withdrawal carries a non-zero fee, and the postings balance to zero", async () => {
      prisma.withdrawal.findUniqueOrThrow.mockResolvedValue({
        id: "wd-1",
        userId: "user-1",
        assetNetworkId: "an-1",
        status: "CONFIRMING",
        amount: new Prisma.Decimal(100),
        fee: new Prisma.Decimal(5),
      });

      await service.recordConfirmation("wd-1", 12, 12);

      const postings = ledger.postTransaction.mock.calls[0][1].postings as Array<{ account: { type: string; key?: string; userId?: string }; amount: Prisma.Decimal.Value }>;
      expect(postings).toHaveLength(3);
      const total = postings.reduce((sum, p) => sum.plus(new Prisma.Decimal(p.amount)), new Prisma.Decimal(0));
      expect(total.isZero()).toBe(true);
      const feeLeg = postings.find((p) => p.account.key === "FEE_REVENUE");
      expect(feeLeg?.amount.toString()).toBe("5");
      const externalChainLeg = postings.find((p) => p.account.key === "EXTERNAL_CHAIN");
      expect(externalChainLeg?.amount.toString()).toBe("95"); // amount - fee
    });

    it("is idempotent — a second call after CREDITED does not post a second ledger transaction", async () => {
      prisma.withdrawal.updateMany.mockResolvedValueOnce({ count: 0 }); // already CREDITED
      await service.recordConfirmation("wd-1", 12, 12);
      expect(ledger.postTransaction).not.toHaveBeenCalled();
    });
  });

  describe("fail", () => {
    it("releases the reservation, transitions to FAILED, and records a SYSTEM-actor audit row (no admin HTTP caller wraps this — see WithdrawalWatcherService)", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", status: "CONFIRMING" });

      const result = await service.fail("wd-1", "Broadcast transaction 0xabc failed on-chain.");

      expect(result.status).toBe("FAILED");
      expect(reservations.release).toHaveBeenCalledWith(prisma, "res-1");
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: "SYSTEM",
          action: "withdrawal.failed",
          resourceType: "Withdrawal",
          resourceId: "wd-1",
          after: expect.objectContaining({ status: "FAILED" }),
        }),
      );
    });

    it("rejects a withdrawal already in a terminal state (e.g. already CREDITED) via CAS, never double-releasing a reservation", async () => {
      prisma.withdrawal.updateMany.mockResolvedValue({ count: 0 });
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", status: "CREDITED" });

      await expect(service.fail("wd-1", "some reason")).rejects.toThrow(ConflictException);
      expect(reservations.release).not.toHaveBeenCalled();
    });
  });

  describe("reconcile", () => {
    it("rejects a non-SUPER_ADMIN actor", async () => {
      prisma.user.findUnique.mockResolvedValue({ id: "admin-1", role: "ADMIN" });
      await expect(service.reconcile("wd-1", "admin-1")).rejects.toThrow(ForbiddenException);
    });

    it("reports no discrepancy and never touches the chain when no txHash is recorded yet", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", txHash: null, status: "APPROVED" });
      const report = await service.reconcile("wd-1", "admin-1");
      expect(report.discrepancy).toBe(false);
      expect(custodyProviderFactory.resolve).not.toHaveBeenCalled();
    });

    it("flags a discrepancy when internal state claims broadcast but the chain reports not_found — never mutates the withdrawal", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", txHash: "0xabc", assetNetworkId: "an-1", status: "CONFIRMING" });
      custodyProviderFactory.resolve.mockResolvedValue({
        getTransactionStatus: jest.fn().mockResolvedValue({ status: "not_found", confirmations: 0, amount: "0", txHash: "0xabc", assetNetworkId: "an-1" }),
      });

      const report = await service.reconcile("wd-1", "admin-1");

      expect(report.discrepancy).toBe(true);
      expect(prisma.withdrawal.update).not.toHaveBeenCalled();
      expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    });

    it("reports no discrepancy when the chain confirms what internal state expects", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({
        id: "wd-1",
        txHash: "0xabc",
        assetNetworkId: "an-1",
        status: "CONFIRMING",
        amount: new Prisma.Decimal(100),
        fee: new Prisma.Decimal(0),
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
      });
      custodyProviderFactory.resolve.mockResolvedValue({
        getTransactionStatus: jest.fn().mockResolvedValue({ status: "confirmed", confirmations: 3, amount: "100", txHash: "0xabc", assetNetworkId: "an-1" }),
      });

      const report = await service.reconcile("wd-1", "admin-1");
      expect(report.discrepancy).toBe(false);
    });

    it("flags a discrepancy when the chain-observed destination does not match the withdrawal's recorded destination", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({
        id: "wd-1",
        txHash: "0xabc",
        assetNetworkId: "an-1",
        status: "CONFIRMING",
        amount: new Prisma.Decimal(100),
        fee: new Prisma.Decimal(0),
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
      });
      custodyProviderFactory.resolve.mockResolvedValue({
        getTransactionStatus: jest.fn().mockResolvedValue({
          status: "confirmed",
          confirmations: 3,
          amount: "100",
          txHash: "0xabc",
          assetNetworkId: "an-1",
          destinationAddress: "0x000000000000000000000000000000000000BEEF",
        }),
      });

      const report = await service.reconcile("wd-1", "admin-1");

      expect(report.discrepancy).toBe(true);
      expect(report.note).toMatch(/destination does not match/i);
    });

    it("flags a discrepancy when the chain-observed amount does not match the withdrawal's expected net amount", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({
        id: "wd-1",
        txHash: "0xabc",
        assetNetworkId: "an-1",
        status: "CONFIRMING",
        amount: new Prisma.Decimal(100),
        fee: new Prisma.Decimal(5),
        destinationAddress: "0x000000000000000000000000000000000000dEaD",
      });
      custodyProviderFactory.resolve.mockResolvedValue({
        getTransactionStatus: jest.fn().mockResolvedValue({
          status: "confirmed",
          confirmations: 3,
          amount: "100", // should have been 95 (amount - fee)
          txHash: "0xabc",
          assetNetworkId: "an-1",
        }),
      });

      const report = await service.reconcile("wd-1", "admin-1");

      expect(report.discrepancy).toBe(true);
      expect(report.note).toMatch(/on-chain amount.*does not match/i);
    });

    it("never flags a discrepancy for a FAILED withdrawal whose broadcast transaction the chain also reports as genuinely failed — that's the correct, consistent outcome", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", txHash: "0xabc", assetNetworkId: "an-1", status: "FAILED" });
      custodyProviderFactory.resolve.mockResolvedValue({
        getTransactionStatus: jest.fn().mockResolvedValue({ status: "failed", confirmations: 0, amount: "0", txHash: "0xabc", assetNetworkId: "an-1" }),
      });

      const report = await service.reconcile("wd-1", "admin-1");
      expect(report.discrepancy).toBe(false);
    });

    it("flags the more dangerous reverse discrepancy: a FAILED withdrawal (reservation already released) whose transaction the chain shows genuinely exists — funds may already have left", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", txHash: "0xabc", assetNetworkId: "an-1", status: "FAILED" });
      custodyProviderFactory.resolve.mockResolvedValue({
        getTransactionStatus: jest.fn().mockResolvedValue({ status: "confirmed", confirmations: 3, amount: "100", txHash: "0xabc", assetNetworkId: "an-1" }),
      });

      const report = await service.reconcile("wd-1", "admin-1");

      expect(report.discrepancy).toBe(true);
      expect(report.note).toMatch(/reservation was released.*chain shows the transaction actually exists/i);
    });

    it("never flags a discrepancy for a FAILED withdrawal whose transaction the chain genuinely never shows — that's the correct, expected outcome, not a discrepancy", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", txHash: "0xabc", assetNetworkId: "an-1", status: "FAILED" });
      custodyProviderFactory.resolve.mockResolvedValue({
        getTransactionStatus: jest.fn().mockResolvedValue({ status: "not_found", confirmations: 0, amount: "0", txHash: "0xabc", assetNetworkId: "an-1" }),
      });

      const report = await service.reconcile("wd-1", "admin-1");
      expect(report.discrepancy).toBe(false);
    });
  });
});
