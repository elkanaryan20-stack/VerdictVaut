import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createIdempotent } from "../prisma/idempotent-create.util";
import { PrismaService } from "../prisma/prisma.service";
import { computeAvailableBalance } from "./balance.util";
import { InsufficientBalanceError, InvalidReservationAmountError } from "./ledger.errors";

export interface ReserveInput {
  userId: string;
  assetSymbol: string;
  amount: Prisma.Decimal.Value;
  referenceType: string;
  referenceId: string;
  /** Unique per attempted reservation — makes a retried reserve() call a safe no-op. */
  idempotencyKey: string;
}

export interface ReservationOutcome {
  reservationId: string;
  /** True if a reservation with this idempotencyKey already existed (no new state change happened). */
  alreadyReserved: boolean;
}

/**
 * Available-vs-reserved funds. Reserving does not move money between
 * accounts (it is not a LedgerTransaction) — it only earmarks part of a
 * single account's own balance, so a hold on an order or a pending
 * withdrawal reduces what's available without ever touching anyone
 * else's balance. Every method here must run inside a transaction opened
 * by SerializableTransactionRunner, same as LedgerService.
 *
 * release()/capture() are guarded compare-and-swap updates (ACTIVE ->
 * RELEASED|CAPTURED): calling either twice — a double-click, a retried
 * admin request, a race — only succeeds once; the second call sees zero
 * rows match and returns a no-op rather than double-adjusting
 * reservedBalance.
 */
@Injectable()
export class ReservationService {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(tx: Prisma.TransactionClient, input: ReserveInput): Promise<ReservationOutcome> {
    const amount = new Prisma.Decimal(input.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new InvalidReservationAmountError(amount.toString());
    }

    const asset = await tx.asset.findUniqueOrThrow({ where: { symbol: input.assetSymbol } });
    const account = await tx.ledgerAccount.upsert({
      where: { userId_assetId: { userId: input.userId, assetId: asset.id } },
      create: { ownerType: "USER", userId: input.userId, assetId: asset.id, cachedBalance: 0, reservedBalance: 0 },
      update: {},
    });

    const { row: reservation, alreadyExisted } = await createIdempotent(
      tx,
      "idempotencyKey",
      () =>
        tx.fundReservation.create({
          data: {
            accountId: account.id,
            amount,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
            idempotencyKey: input.idempotencyKey,
          },
        }),
      () => tx.fundReservation.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } }),
    );

    if (alreadyExisted) {
      return { reservationId: reservation.id, alreadyReserved: true };
    }
    const reservationId = reservation.id;

    const available = computeAvailableBalance(account.cachedBalance, account.reservedBalance);
    if (available.lessThan(amount)) {
      // Throwing aborts the whole transaction, including the FundReservation
      // insert above — nothing is left partially applied.
      throw new InsufficientBalanceError(account.id, available.toString(), amount.toString());
    }

    await tx.ledgerAccount.update({
      where: { id: account.id },
      data: { reservedBalance: account.reservedBalance.plus(amount) },
    });

    return { reservationId, alreadyReserved: false };
  }

  async release(tx: Prisma.TransactionClient, reservationId: string): Promise<{ released: boolean }> {
    return this.transition(tx, reservationId, "RELEASED", "releasedAt");
  }

  async capture(tx: Prisma.TransactionClient, reservationId: string): Promise<{ captured: boolean }> {
    const result = await this.transition(tx, reservationId, "CAPTURED", "capturedAt");
    return { captured: result.released };
  }

  /**
   * Applies a partial (or full) execution against a still-ACTIVE
   * reservation, WITHOUT changing its status — the reservation stays
   * ACTIVE, earmarking whatever remains for the rest of the order. Callers
   * (the ExecutionCoordinator) are responsible for ensuring this is invoked
   * at most once per fill: it is not itself idempotency-keyed, and relying
   * on an external once-only gate (the Fill row's unique idempotencyKey,
   * created in the same transaction before this is called) is the same
   * pattern already used throughout this codebase for gating a ledger
   * write behind a status-transition guard.
   */
  async consume(tx: Prisma.TransactionClient, reservationId: string, amount: Prisma.Decimal.Value): Promise<void> {
    const amt = new Prisma.Decimal(amount);
    if (amt.lessThanOrEqualTo(0)) {
      throw new InvalidReservationAmountError(amt.toString());
    }

    const reservation = await tx.fundReservation.findUniqueOrThrow({ where: { id: reservationId } });
    if (reservation.status !== "ACTIVE") {
      throw new Error(`Cannot consume FundReservation ${reservationId}: status is ${reservation.status}, not ACTIVE`);
    }

    const unconsumed = reservation.amount.minus(reservation.consumedAmount);
    if (amt.greaterThan(unconsumed)) {
      throw new Error(
        `Cannot consume ${amt.toString()} from FundReservation ${reservationId}: only ${unconsumed.toString()} unconsumed`,
      );
    }

    await tx.fundReservation.update({
      where: { id: reservationId },
      data: { consumedAmount: reservation.consumedAmount.plus(amt) },
    });

    const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: reservation.accountId } });
    await tx.ledgerAccount.update({
      where: { id: account.id },
      data: { reservedBalance: account.reservedBalance.minus(amt) },
    });
  }

  private async transition(
    tx: Prisma.TransactionClient,
    reservationId: string,
    nextStatus: "RELEASED" | "CAPTURED",
    timestampField: "releasedAt" | "capturedAt",
  ): Promise<{ released: boolean }> {
    const result = await tx.fundReservation.updateMany({
      where: { id: reservationId, status: "ACTIVE" },
      data: { status: nextStatus, [timestampField]: new Date() },
    });

    if (result.count === 0) {
      return { released: false };
    }

    const reservation = await tx.fundReservation.findUniqueOrThrow({ where: { id: reservationId } });
    const account = await tx.ledgerAccount.findUniqueOrThrow({ where: { id: reservation.accountId } });

    // Only the still-earmarked (never-consumed) remainder is released back
    // to available balance — the already-consumed portion left reservedBalance
    // permanently as part of the fill's own accounting (see consume()) and
    // must never be subtracted a second time here.
    const unconsumed = reservation.amount.minus(reservation.consumedAmount);
    await tx.ledgerAccount.update({
      where: { id: account.id },
      data: { reservedBalance: account.reservedBalance.minus(unconsumed) },
    });

    return { released: true };
  }

  async findActiveByReference(tx: Prisma.TransactionClient, referenceType: string, referenceId: string) {
    return tx.fundReservation.findFirst({ where: { referenceType, referenceId, status: "ACTIVE" } });
  }
}
