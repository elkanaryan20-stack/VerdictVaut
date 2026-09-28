import { Prisma } from "@prisma/client";
import { PrismaService } from "./prisma.service";
import { SerializableTransactionRunner } from "./serializable-transaction-runner";

/**
 * Phase 38 — which failures are retried. A deadlock (40P01) aborts the
 * victim transaction in full just like a serialization failure, so it is
 * equally safe to re-run; Prisma surfaces it as a
 * PrismaClientUnknownRequestError carrying only the message, which was
 * previously never recognized (measured under hot-market load: those
 * orders were funded but left unmatched).
 */
describe("SerializableTransactionRunner retry classification", () => {
  function runnerWith(failures: unknown[]) {
    const attempts: number[] = [];
    const prisma = {
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        attempts.push(attempts.length + 1);
        const failure = failures.shift();
        if (failure) throw failure;
        return fn({});
      }),
    };
    const metrics = { increment: jest.fn(), timing: jest.fn() };
    const runner = new SerializableTransactionRunner(prisma as unknown as PrismaService, metrics as never);
    return { runner, attempts, metrics };
  }

  const deadlockUnknown = () =>
    new Prisma.PrismaClientUnknownRequestError('Error occurred during query execution: ConnectorError { code: "40P01", message: "deadlock detected" }', {
      clientVersion: "5.22.0",
    });
  const serialization = () => new Prisma.PrismaClientKnownRequestError("write conflict", { code: "P2034", clientVersion: "5.22.0" });

  it("retries a deadlock surfaced as PrismaClientUnknownRequestError (40P01) and then succeeds", async () => {
    const { runner, attempts, metrics } = runnerWith([deadlockUnknown(), deadlockUnknown()]);
    await expect(runner.run(async () => "ok")).resolves.toBe("ok");
    expect(attempts).toHaveLength(3);
    expect(metrics.increment).toHaveBeenCalledWith("db.transaction.retry", { reason: "deadlock" });
  });

  it("retries a deadlock surfaced with meta.code 40P01", async () => {
    const known = new Prisma.PrismaClientKnownRequestError("deadlock", { code: "P2010", clientVersion: "5.22.0", meta: { code: "40P01" } });
    const { runner, attempts } = runnerWith([known]);
    await expect(runner.run(async () => "ok")).resolves.toBe("ok");
    expect(attempts).toHaveLength(2);
  });

  it("still retries serialization failures (P2034) as before", async () => {
    const { runner, metrics } = runnerWith([serialization()]);
    await expect(runner.run(async () => "ok")).resolves.toBe("ok");
    expect(metrics.increment).toHaveBeenCalledWith("db.transaction.retry", { reason: "serialization" });
  });

  it("gives up after maxAttempts and reports the exhaustion as its own signal", async () => {
    const { runner, attempts, metrics } = runnerWith([serialization(), serialization(), serialization()]);
    await expect(runner.run(async () => "ok", { maxAttempts: 3 })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(attempts).toHaveLength(3);
    expect(metrics.increment).toHaveBeenCalledWith("db.transaction.retries_exhausted", { reason: "serialization" });
  });

  it("never retries an ordinary error (e.g. a business rule or constraint violation)", async () => {
    const { runner, attempts } = runnerWith([new Error("Insufficient balance")]);
    await expect(runner.run(async () => "ok")).rejects.toThrow("Insufficient balance");
    expect(attempts).toHaveLength(1);
  });
});
