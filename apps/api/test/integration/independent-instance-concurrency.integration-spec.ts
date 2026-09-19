import { Prisma } from "@prisma/client";
import { LedgerService } from "../../src/ledger/ledger.service";
import { ReservationService } from "../../src/ledger/reservation.service";
import { InsufficientBalanceError } from "../../src/ledger/ledger.errors";
import { PrismaService } from "../../src/prisma/prisma.service";
import { SerializableTransactionRunner } from "../../src/prisma/serializable-transaction-runner";
import { createTestUser, fundUserForTest, getUserAccount } from "./helpers";

/**
 * Phase 32 — every other concurrency test in this suite (see
 * ledger-concurrency.integration-spec.ts) races Promise.all callers
 * against ONE shared, module-level LedgerService/ReservationService/
 * PrismaService singleton (test/integration/helpers.ts). That is a real
 * concurrency test at the Postgres level (each call opens its own
 * SERIALIZABLE transaction/connection), but it leaves a methodological
 * gap: it cannot distinguish "safe because of real DB-level isolation"
 * from "safe only because the racing callers happen to share one
 * process's JS object" — which is what production concurrency actually
 * looks like (multiple API pod replicas, each with their own PrismaClient
 * connection pool, all racing the same Postgres rows).
 *
 * This file closes that gap directly: every racing caller below gets its
 * OWN fully independent PrismaService (own PrismaClient, own connection),
 * own SerializableTransactionRunner, own LedgerService, own
 * ReservationService — nothing shared except the target database rows.
 * If these still pass, it's proof the safety is coming from Postgres
 * SERIALIZABLE isolation + the DB-level CHECK constraints, not from any
 * accidental single-process serialization.
 */
describe("Financial mutation safety under TRUE independent-instance concurrency (real Postgres)", () => {
  const instanceCount = 8;
  const instances = Array.from({ length: instanceCount }, () => {
    const prisma = new PrismaService();
    const txRunner = new SerializableTransactionRunner(prisma);
    const ledger = new LedgerService(prisma);
    const reservations = new ReservationService(prisma);
    return { prisma, txRunner, ledger, reservations };
  });

  afterAll(async () => {
    await Promise.all(instances.map((i) => i.prisma.$disconnect()));
  });

  it("debits raced across independent service instances never drive a shared account negative", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "100");

    // 15 independent "pods" each try to debit 10 against a balance of
    // 100 — at most 10 can win; the DB-level non-negative-balance CHECK
    // constraint (and LedgerService's own pre-write balance check) is
    // the only thing that can be enforcing that, since no two of these
    // callers share a single byte of JS state.
    const attempts = Array.from({ length: 15 }, (_, i) => {
      const instance = instances[i % instances.length];
      const referenceId = `independent-debit-${user.id}-${i}`;
      return instance.txRunner.run((tx) =>
        instance.ledger.postTransaction(tx, {
          assetSymbol: "USDC",
          type: "ADJUSTMENT",
          referenceType: "IndependentInstanceConcurrencyTest",
          referenceId,
          idempotencyKey: `independent-debit:${referenceId}`,
          postings: [
            { account: { type: "USER", userId: user.id }, amount: "-10" },
            { account: { type: "HOUSE", key: "FEE_REVENUE" }, amount: "10" },
          ],
        }),
      );
    });

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(5);
    for (const r of rejected as PromiseRejectedResult[]) {
      expect(r.reason).toBeInstanceOf(InsufficientBalanceError);
    }

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.cachedBalance.toString()).toBe("0");
    expect(new Prisma.Decimal(account!.cachedBalance).greaterThanOrEqualTo(0)).toBe(true);
  });

  it("fund reservations raced across independent service instances never over-reserve a shared account", async () => {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "100");

    // Same shape as the debit case, but through ReservationService.reserve
    // — a read-then-write path with no app-level lock of any kind (see
    // reservation.service.ts's own docblock). 15 independent instances
    // each try to reserve 10 against 100 available; at most 10 may win.
    const attempts = Array.from({ length: 15 }, (_, i) => {
      const instance = instances[i % instances.length];
      const referenceId = `independent-reserve-${user.id}-${i}`;
      return instance.txRunner.run((tx) =>
        instance.reservations.reserve(tx, {
          userId: user.id,
          assetSymbol: "USDC",
          amount: "10",
          referenceType: "IndependentInstanceConcurrencyTest",
          referenceId,
          idempotencyKey: `independent-reserve:${referenceId}`,
        }),
      );
    });

    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(5);
    for (const r of rejected as PromiseRejectedResult[]) {
      expect(r.reason).toBeInstanceOf(InsufficientBalanceError);
    }

    const account = await getUserAccount(user.id, "USDC");
    expect(account?.reservedBalance.toString()).toBe("100");
    expect(account?.cachedBalance.toString()).toBe("100");
  });
});
