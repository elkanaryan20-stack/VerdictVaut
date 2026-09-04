import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { MarketStatus, OrderStatus, OrderType, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CreateOrderDto } from "./dto/create-order.dto";

/**
 * Order intake and lifecycle only. There is intentionally no matching
 * engine here yet — orders are validated and persisted as OPEN, but
 * nothing crosses/fills them or moves ledger funds. Wiring a real
 * price-time-priority matcher (and the ledger holds that go with it) is
 * a follow-up, not something to fake in this foundation.
 */
@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateOrderDto) {
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

    return this.prisma.order.create({
      data: {
        userId,
        marketId: market.id,
        outcomeId: outcome.id,
        side: dto.side,
        type: dto.type,
        price,
        quantity,
        status: OrderStatus.OPEN,
      },
    });
  }

  async cancel(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    if (order.userId !== userId) {
      throw new ForbiddenException("Not your order");
    }
    if (order.status !== OrderStatus.OPEN && order.status !== OrderStatus.PARTIALLY_FILLED) {
      throw new BadRequestException(`Cannot cancel an order in status ${order.status}`);
    }

    return this.prisma.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELLED } });
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
