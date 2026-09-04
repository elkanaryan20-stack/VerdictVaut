import { Prisma } from "@prisma/client";

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
    const row = await findExisting();
    return { row, alreadyExisted: true };
  }
}
