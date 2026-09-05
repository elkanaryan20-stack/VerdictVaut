import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createIdempotent } from "../../prisma/idempotent-create.util";
import { PrismaService } from "../../prisma/prisma.service";
import { InsufficientPositionError } from "../trading.errors";

export interface ReservePositionInput {
  userId: string;
  marketId: string;
  outcomeId: string;
  /** Quantity of outcome shares to earmark. */
  amount: Prisma.Decimal.Value;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
}

export interface PositionReservationOutcome {
  reservationId: string;
  alreadyReserved: boolean;
}

/**
 * Outcome-share reservation — the position-quantity counterpart to
 * ReservationService (cash). A SELL order reserves shares here, exactly
 * the way a withdrawal or a BUY order reserves cash there: the same
 * idempotent-create-via-SAVEPOINT primitive, the same ACTIVE ->
 * RELEASED|CAPTURED guarded compare-and-swap, the same
 * available-before-reserve check. This is deliberately a parallel
 * implementation, not a shared one — FundReservation is hard-FK'd to
 * LedgerAccount (a real-asset account), and outcome shares are not a
 * LedgerAccount asset, so reusing it directly would conflate two
 * different kinds of holding. Every method here must run inside a
 * transaction opened by SerializableTransactionRunner.
 */
@Injectable()
export class PositionReservationService {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(tx: Prisma.TransactionClient, input: ReservePositionInput): Promise<PositionReservationOutcome> {
    const amount = new Prisma.Decimal(input.amount);
    if (amount.lessThanOrEqualTo(0)) {
      throw new Error(`Position reservation amount must be positive, got ${amount.toString()}`);
    }

    // Never auto-created with a non-zero quantity — a position with no
    // prior fills has zero shares, so a SELL reservation against it will
    // correctly fail as insufficient rather than fabricating inventory.
    const position = await tx.position.upsert({
      where: { userId_marketId_outcomeId: { userId: input.userId, marketId: input.marketId, outcomeId: input.outcomeId } },
      create: { userId: input.userId, marketId: input.marketId, outcomeId: input.outcomeId, quantity: 0, reservedQuantity: 0 },
      update: {},
    });

    const { row: reservation, alreadyExisted } = await createIdempotent(
      tx,
      "idempotencyKey",
      () =>
        tx.positionReservation.create({
          data: {
            positionId: position.id,
            amount,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
            idempotencyKey: input.idempotencyKey,
          },
        }),
      () => tx.positionReservation.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } }),
    );

    if (alreadyExisted) {
      return { reservationId: reservation.id, alreadyReserved: true };
    }
    const reservationId = reservation.id;

    const available = position.quantity.minus(position.reservedQuantity);
    if (available.lessThan(amount)) {
      // Aborts the whole transaction, including the just-inserted
      // PositionReservation row above — nothing is left partially applied.
      throw new InsufficientPositionError(position.id, available.toString(), amount.toString());
    }

    await tx.position.update({
      where: { id: position.id },
      data: { reservedQuantity: position.reservedQuantity.plus(amount) },
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
   * reservation, WITHOUT changing its status — see ReservationService.consume,
   * whose contract and reliance on an external once-only gate (the Fill
   * row's idempotencyKey) this mirrors exactly.
   */
  async consume(tx: Prisma.TransactionClient, reservationId: string, amount: Prisma.Decimal.Value): Promise<void> {
    const amt = new Prisma.Decimal(amount);
    if (amt.lessThanOrEqualTo(0)) {
      throw new Error(`Position reservation consume amount must be positive, got ${amt.toString()}`);
    }

    const reservation = await tx.positionReservation.findUniqueOrThrow({ where: { id: reservationId } });
    if (reservation.status !== "ACTIVE") {
      throw new Error(`Cannot consume PositionReservation ${reservationId}: status is ${reservation.status}, not ACTIVE`);
    }

    const unconsumed = reservation.amount.minus(reservation.consumedAmount);
    if (amt.greaterThan(unconsumed)) {
      throw new Error(
        `Cannot consume ${amt.toString()} from PositionReservation ${reservationId}: only ${unconsumed.toString()} unconsumed`,
      );
    }

    await tx.positionReservation.update({
      where: { id: reservationId },
      data: { consumedAmount: reservation.consumedAmount.plus(amt) },
    });

    const position = await tx.position.findUniqueOrThrow({ where: { id: reservation.positionId } });
    await tx.position.update({
      where: { id: position.id },
      data: { reservedQuantity: position.reservedQuantity.minus(amt) },
    });
  }

  private async transition(
    tx: Prisma.TransactionClient,
    reservationId: string,
    nextStatus: "RELEASED" | "CAPTURED",
    timestampField: "releasedAt" | "capturedAt",
  ): Promise<{ released: boolean }> {
    const result = await tx.positionReservation.updateMany({
      where: { id: reservationId, status: "ACTIVE" },
      data: { status: nextStatus, [timestampField]: new Date() },
    });

    if (result.count === 0) {
      return { released: false };
    }

    const reservation = await tx.positionReservation.findUniqueOrThrow({ where: { id: reservationId } });
    const position = await tx.position.findUniqueOrThrow({ where: { id: reservation.positionId } });

    // Only the still-earmarked (never-consumed) remainder is released —
    // the consumed portion already left reservedQuantity permanently as
    // part of the fill's own accounting (see consume()).
    const unconsumed = reservation.amount.minus(reservation.consumedAmount);
    await tx.position.update({
      where: { id: position.id },
      data: { reservedQuantity: position.reservedQuantity.minus(unconsumed) },
    });

    return { released: true };
  }

  async findActiveByReference(tx: Prisma.TransactionClient, referenceType: string, referenceId: string) {
    return tx.positionReservation.findFirst({ where: { referenceType, referenceId, status: "ACTIVE" } });
  }
}
