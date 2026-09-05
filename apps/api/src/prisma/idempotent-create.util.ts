import { Prisma } from "@prisma/client";

/**
 * Thrown by createIdempotent when the database reports a unique-constraint
 * conflict but the fallback lookup, run in the SAME transaction, cannot
 * find the conflicting row. This is not a bug in the lookup — it is a
 * real, if unusual, PostgreSQL MVCC behavior: a unique index enforces
 * against the latest COMMITTED row regardless of the current
 * transaction's snapshot, but a plain SELECT still only sees what that
 * snapshot could see. If transaction B's snapshot was taken before
 * transaction A committed the conflicting row, B's INSERT can still fail
 * with a unique violation (correctly detected against A's now-committed
 * row) while a subsequent SELECT within B's own transaction still cannot
 * see it — B's snapshot is fixed for its entire duration, unaffected by
 * A's commit or by ROLLBACK TO SAVEPOINT. The only correct recovery is to
 * retry the whole transaction with a fresh snapshot (see
 * SerializableTransactionRunner, which treats this exactly like a
 * serialization failure) — not to keep querying inside the same one.
 */
export class StaleSnapshotConflictError extends Error {
  constructor(uniqueField: string) {
    super(
      `createIdempotent: a unique-constraint conflict on "${uniqueField}" was detected, but the conflicting row is not visible to this transaction's snapshot. The whole transaction must be retried with a fresh snapshot.`,
    );
    this.name = "StaleSnapshotConflictError";
  }
}

export function isUniqueConstraintViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const target = (error.meta as { target?: string[] | string } | undefined)?.target;
  return Array.isArray(target) ? target.includes(field) : target === field;
}

let savepointCounter = 0;

/**
 * Postgres aborts the *entire* transaction after any statement fails —
 * including a unique-constraint violation — so a plain
 * try { create() } catch (P2002) { findExisting() } does not work inside
 * an interactive Prisma transaction: the lookup in the catch block would
 * itself fail with "current transaction is aborted, commands ignored
 * until end of transaction block". A SAVEPOINT scopes that abort to just
 * the failed insert, letting the rest of the transaction (including the
 * fallback lookup) continue normally.
 *
 * This is the mechanism idempotency-key based "create or return existing"
 * logic relies on everywhere in the ledger (LedgerTransaction,
 * FundReservation) — it must run inside the caller's transaction client.
 */
export async function createIdempotent<T>(
  tx: Prisma.TransactionClient,
  uniqueField: string,
  create: () => Promise<T>,
  findExisting: () => Promise<T>,
): Promise<{ row: T; alreadyExisted: boolean }> {
  savepointCounter += 1;
  const savepoint = `idempotent_create_${savepointCounter}_${Date.now()}`;

  await tx.$executeRawUnsafe(`SAVEPOINT "${savepoint}"`);
  try {
    const row = await create();
    return { row, alreadyExisted: false };
  } catch (error) {
    if (!isUniqueConstraintViolation(error, uniqueField)) {
      throw error;
    }
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "${savepoint}"`);
    let row: T;
    try {
      row = await findExisting();
    } catch {
      throw new StaleSnapshotConflictError(uniqueField);
    }
    if (row === null || row === undefined) {
      throw new StaleSnapshotConflictError(uniqueField);
    }
    return { row, alreadyExisted: true };
  }
}
