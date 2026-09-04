import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { MarketStatus, OrderSide, OrderStatus, OrderType, Prisma, UserStatus } from "@prisma/client";
import { ReservationService } from "../ledger/reservation.service";
import { PrismaService } from "../prisma/prisma.service";
import { SerializableTransactionRunner } from "../prisma/serializable-transaction-runner";
import { CreateOrderDto } from "./dto/create-order.dto";

/**
 * Order intake and lifecycle only. There is intentionally no matching
 * engine here yet — orders are validated and persisted as OPEN, but
 * nothing crosses/fills them. Wiring a real price-time-priority matcher
 * is a follow-up, not something to fake in this foundation.
 *
 * What IS wired up now is available-vs-reserved funds for the cash side
 * of a BUY order: placing one reserves `quantity * price` (or, for a
 * MARKET order with no known price yet, the worst-case `quantity * 1`,
 * since a share's price is always < 1) so the same funds can't be
 * double-committed to two open orders. Cancelling releases the
 * reservation. SELL orders are not covered here — selling requires
 * holding the shares (Position), and share-inventory reservation is a
 * separate mechanism that doesn't exist until positions are populated by
 * real fills, which this phase deliberately does not build.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationService,
    private readonly txRunner: SerializableTransactionRunner,
  ) {}

  async create(userId: string, dto: CreateOrderDto) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException("Account must be verified (ACTIVE) to trade");
    }

    const market = await this.prisma.market.findUnique({ where: { id: dto.marketId } });
    if (!market) {
      throw new NotFoundException("Market not found");
    }
    if (market.status !== MarketStatus.OPEN) {
      throw new BadRequestException("Market is not open for trading");
    }

    const outcome = await this.prisma.marketOutcome.findUnique({ where: { id: dto.outcomeId } });
    if (!outcome || outcome.marketId !== market.id) {
      throw new BadRequestException("Outcome does not belong to this market");
    }

    const quantity = new Prisma.Decimal(dto.quantity);
    if (quantity.lessThanOrEqualTo(0)) {
      throw new BadRequestException("quantity must be greater than zero");
    }

    let price: Prisma.Decimal | null = null;
    if (dto.type === OrderType.LIMIT) {
      if (!dto.price) {
        throw new BadRequestException("price is required for LIMIT orders");
      }
      price = new Prisma.Decimal(dto.price);
      if (price.lessThanOrEqualTo(0) || price.greaterThanOrEqualTo(1)) {
        throw new BadRequestException("price must be a probability strictly between 0 and 1");
      }
    }

    if (dto.side === OrderSide.BUY) {
      const settlementAsset = await this.prisma.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } });
      // Worst-case bound for a MARKET order, since no book exists yet to
      // know its actual fill price — a share's price is always < 1.
      const costBasisPrice = price ?? new Prisma.Decimal(1);
      const requiredFunds = quantity.times(costBasisPrice);

      return this.txRunner.run(async (tx) => {
        const order = await tx.order.create({
          data: { userId, marketId: market.id, outcomeId: outcome.id, side: dto.side, type: dto.type, price, quantity, status: OrderStatus.OPEN },
        });

        await this.reservations.reserve(tx, {
          userId,
          assetSymbol: settlementAsset.symbol,
          amount: requiredFunds,
          referenceType: "Order",
          referenceId: order.id,
          idempotencyKey: `order-reserve:${order.id}`,
        });

        return order;
      });
    }

    return this.prisma.order.create({
      data: { userId, marketId: market.id, outcomeId: outcome.id, side: dto.side, type: dto.type, price, quantity, status: OrderStatus.OPEN },
    });
  }

  async cancel(userId: string, orderId: string) {
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

      const reservation = await this.reservations.findActiveByReference(tx, "Order", orderId);
      if (reservation) {
        await this.reservations.release(tx, reservation.id);
      }

      return tx.order.findUniqueOrThrow({ where: { id: orderId } });
    });
  }

  async listMine(userId: string) {
    return this.prisma.order.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  async listMyPositions(userId: string) {
    return this.prisma.position.findMany({
      where: { userId },
      include: { outcome: { include: { market: true } } },
    });
  }
}
