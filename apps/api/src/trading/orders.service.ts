import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { MarketStatus, Order, OrderSide, OrderStatus, OrderType, Prisma, UserStatus } from "@prisma/client";
import * as crypto from "crypto";
import { FEE_CALCULATOR, FeeCalculator } from "./fees/fee-calculator.interface";
import { ReservationService } from "../ledger/reservation.service";
import { PrismaService } from "../prisma/prisma.service";
import { SerializableTransactionRunner } from "../prisma/serializable-transaction-runner";
import { createIdempotent } from "../prisma/idempotent-create.util";
import { PositionReservationService } from "./positions/position-reservation.service";
import { OrderRiskValidator } from "./risk/order-risk-validator.service";
import { CreateOrderDto } from "./dto/create-order.dto";

/**
 * Order intake and lifecycle only — there is intentionally no matching
 * engine here yet (see trading/matching/). Orders are validated,
 * risk-checked, funded, and persisted as resting OPEN orders; nothing
 * crosses/fills them.
 *
 * Price convention: prices are probabilities on the OPEN interval (0, 1)
 * — strictly greater than 0, strictly less than 1 — enforced both here
 * and by a DB CHECK constraint (orders_price_probability_check). This is
 * deliberately NOT enforced as "YES price + NO price = 1" at the
 * database level: resting orders for the same outcome can and do sit at
 * many different prices simultaneously, so that invariant (if it's
 * wanted at all) is a property of the matched/settled state, not of any
 * individual order row.
 *
 * Only LIMIT orders are accepted. OrderType.MARKET exists in the schema
 * for forward compatibility but is rejected here — a resting "market
 * order" with no matcher to execute it immediately would be a
 * misleading, incoherent state, not a safe simplification.
 *
 * Funding: BUY reserves cash (quantity * price + fee estimate) via
 * ReservationService against the settlement-currency LedgerAccount. SELL
 * reserves outcome shares via PositionReservationService against the
 * user's Position for that market/outcome — a distinct mechanism because
 * shares are not a LedgerAccount asset (see position-reservation.service
 * .ts for why these are deliberately not the same primitive).
 *
 * Atomicity: idempotent order creation, risk validation, and funds/share
 * reservation all run inside ONE SerializableTransactionRunner
 * transaction. If reservation fails (insufficient funds/shares), the
 * whole transaction — including the just-created order row — rolls
 * back: there is never an order with no reservation behind it.
 *
 * Idempotency: clientOrderId (client-supplied or server-generated) is
 * unique per (userId, clientOrderId). A retried or genuinely concurrent
 * duplicate submission is detected via the same SAVEPOINT-based
 * createIdempotent primitive the ledger uses, and returns the original
 * order rather than creating a second one or reserving funds twice.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationService,
    private readonly positionReservations: PositionReservationService,
    private readonly riskValidator: OrderRiskValidator,
    @Inject(FEE_CALCULATOR) private readonly feeCalculator: FeeCalculator,
    private readonly txRunner: SerializableTransactionRunner,
  ) {}

  async create(userId: string, dto: CreateOrderDto): Promise<Order> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException("Account must be verified (ACTIVE) to trade");
    }

    if (dto.type === OrderType.MARKET) {
      throw new BadRequestException(
        "MARKET orders are not supported yet — only LIMIT orders can be placed until a matching engine exists to execute them immediately.",
      );
    }

    const market = await this.prisma.market.findUnique({ where: { id: dto.marketId } });
    if (!market) {
      throw new NotFoundException("Market not found");
    }
    if (market.status !== MarketStatus.OPEN) {
      throw new BadRequestException("Market is not open for trading");
    }
    if (market.closeTime && market.closeTime.getTime() <= Date.now()) {
      throw new BadRequestException("Market has passed its close time");
    }

    const outcome = await this.prisma.marketOutcome.findUnique({ where: { id: dto.outcomeId } });
    if (!outcome || outcome.marketId !== market.id) {
      throw new BadRequestException("Outcome does not belong to this market");
    }

    const quantity = new Prisma.Decimal(dto.quantity);
    if (quantity.lessThanOrEqualTo(0)) {
      throw new BadRequestException("quantity must be greater than zero");
    }

    if (!dto.price) {
      throw new BadRequestException("price is required for LIMIT orders");
    }
    const price = new Prisma.Decimal(dto.price);
    if (price.lessThanOrEqualTo(0) || price.greaterThanOrEqualTo(1)) {
      throw new BadRequestException("price must be a probability strictly between 0 and 1");
    }

    const clientOrderId = dto.clientOrderId ?? crypto.randomUUID();

    // Read-only, doesn't depend on the order being created — safe to fetch
    // ahead of the transaction. Only needed for BUY (the cash side).
    const settlementAssetSymbol =
      dto.side === OrderSide.BUY
        ? (await this.prisma.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } })).symbol
        : null;

    return this.txRunner.run(async (tx) => {
      const { row: order, alreadyExisted } = await createIdempotent(
        tx,
        "clientOrderId",
        async () => {
          await this.riskValidator.validate(
            { userId, marketId: market.id, outcomeId: outcome.id, side: dto.side, price, quantity },
            tx,
          );

          return tx.order.create({
            data: {
              userId,
              marketId: market.id,
              outcomeId: outcome.id,
              side: dto.side,
              type: OrderType.LIMIT,
              price,
              quantity,
              filledQuantity: new Prisma.Decimal(0),
              remainingQuantity: quantity,
              status: OrderStatus.OPEN,
              clientOrderId,
            },
          });
        },
        () => tx.order.findUniqueOrThrow({ where: { userId_clientOrderId: { userId, clientOrderId } } }),
      );

      if (alreadyExisted) {
        return order;
      }

      if (dto.side === OrderSide.BUY) {
        const feeBuffer = this.feeCalculator.estimateBuyReserveFee({
          marketId: market.id,
          outcomeId: outcome.id,
          price,
          quantity,
        });
        const requiredFunds = quantity.times(price).plus(feeBuffer);

        await this.reservations.reserve(tx, {
          userId,
          assetSymbol: settlementAssetSymbol!,
          amount: requiredFunds,
          referenceType: "Order",
          referenceId: order.id,
          idempotencyKey: `order-reserve:${order.id}`,
        });
      } else {
        await this.positionReservations.reserve(tx, {
          userId,
          marketId: market.id,
          outcomeId: outcome.id,
          amount: quantity,
          referenceType: "Order",
          referenceId: order.id,
          idempotencyKey: `order-reserve:${order.id}`,
        });
      }

      return order;
    });
  }

  async cancel(userId: string, orderId: string): Promise<Order> {
    return this.txRunner.run(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) {
        throw new NotFoundException("Order not found");
      }
      if (order.userId !== userId) {
        throw new ForbiddenException("Not your order");
      }

      const result = await tx.order.updateMany({
        where: { id: orderId, status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] } },
        data: { status: OrderStatus.CANCELLED },
      });
      if (result.count === 0) {
        throw new BadRequestException(`Cannot cancel an order in status ${order.status}`);
      }

      if (order.side === OrderSide.BUY) {
        const reservation = await this.reservations.findActiveByReference(tx, "Order", orderId);
        if (reservation) {
          await this.reservations.release(tx, reservation.id);
        }
      } else {
        const reservation = await this.positionReservations.findActiveByReference(tx, "Order", orderId);
        if (reservation) {
          await this.positionReservations.release(tx, reservation.id);
        }
      }

      return tx.order.findUniqueOrThrow({ where: { id: orderId } });
    });
  }

  async getOwnOrder(userId: string, orderId: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    if (order.userId !== userId) {
      throw new ForbiddenException("Not your order");
    }
    return order;
  }

  async listMine(userId: string) {
    return this.prisma.order.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }
}
