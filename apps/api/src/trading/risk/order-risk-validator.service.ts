import { BadRequestException, Injectable } from "@nestjs/common";
import { OrderSide, OrderStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

export interface OrderRiskCheckInput {
  userId: string;
  marketId: string;
  outcomeId: string;
  side: OrderSide;
  price: Prisma.Decimal | null;
  quantity: Prisma.Decimal;
}

/**
 * Extension points for order-time risk controls, backed by the existing
 * RiskLimit model. Every limit is opt-in (null = unlimited) — no
 * arbitrary production limit is invented without configuration, per the
 * architecture's standing rule.
 *
 * Market-level exposure (checkMarketExposure) is intentionally advisory
 * rather than a hard per-row guarantee: it sums resting BUY notional by
 * reading the orders table inside the same SERIALIZABLE transaction as
 * order creation, so Postgres's serializable snapshot isolation catches
 * genuine conflicting concurrent writes, but this is not a single-row
 * CAS the way balance/position reservation is — under extreme
 * concurrency a market could transiently exceed maxExposure by one
 * order's worth before the next check catches it. That is documented
 * here, not hidden.
 */
@Injectable()
export class OrderRiskValidator {
  constructor(private readonly prisma: PrismaService) {}

  async validate(input: OrderRiskCheckInput, client: Prisma.TransactionClient | PrismaService = this.prisma): Promise<void> {
    const riskLimit = await client.riskLimit.findUnique({ where: { userId: input.userId } });

    if (riskLimit?.maxOrderQuantity && input.quantity.greaterThan(riskLimit.maxOrderQuantity)) {
      throw new BadRequestException(`Order quantity exceeds your configured maximum of ${riskLimit.maxOrderQuantity.toString()}`);
    }

    if (riskLimit?.maxOrderNotional && input.price) {
      const notional = input.quantity.times(input.price);
      if (notional.greaterThan(riskLimit.maxOrderNotional)) {
        throw new BadRequestException(`Order notional exceeds your configured maximum of ${riskLimit.maxOrderNotional.toString()}`);
      }
    }

    if (riskLimit?.maxPositionSize && input.side === OrderSide.BUY) {
      const position = await client.position.findUnique({
        where: { userId_marketId_outcomeId: { userId: input.userId, marketId: input.marketId, outcomeId: input.outcomeId } },
      });
      const projected = (position?.quantity ?? new Prisma.Decimal(0)).plus(input.quantity);
      if (projected.greaterThan(riskLimit.maxPositionSize)) {
        throw new BadRequestException(`Resulting position would exceed your configured maximum of ${riskLimit.maxPositionSize.toString()}`);
      }
    }

    await this.checkMarketExposure(input, client);
  }

  private async checkMarketExposure(
    input: OrderRiskCheckInput,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    if (input.side !== OrderSide.BUY || !input.price) {
      return;
    }

    const market = await client.market.findUniqueOrThrow({ where: { id: input.marketId } });
    if (!market.maxExposure) {
      return;
    }

    const restingBuys = await client.order.findMany({
      where: {
        marketId: input.marketId,
        outcomeId: input.outcomeId,
        side: OrderSide.BUY,
        status: { in: [OrderStatus.OPEN, OrderStatus.PARTIALLY_FILLED] },
      },
      select: { remainingQuantity: true, price: true },
    });

    const currentExposure = restingBuys.reduce(
      (total, order) => total.plus(order.remainingQuantity.times(order.price ?? 0)),
      new Prisma.Decimal(0),
    );
    const projectedExposure = currentExposure.plus(input.quantity.times(input.price));

    if (projectedExposure.greaterThan(market.maxExposure)) {
      throw new BadRequestException(
        `This order would push open BUY exposure on this market/outcome above its configured cap of ${market.maxExposure.toString()}`,
      );
    }
  }
}
