import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { CreateOrderDto } from "./dto/create-order.dto";
import { OrderBookService } from "./order-book/order-book.service";
import { OrderPlacementResult, OrdersService } from "./orders.service";
import { PositionsService } from "./positions/positions.service";
import { MatchingAttemptFailedException } from "./trading.errors";

type OrderPlacementResponse = OrderPlacementResult & {
  /**
   * True only when the immediate post-placement matching attempt failed
   * (order is still real, real funded, and resting — see
   * MatchingAttemptFailedException). Absent entirely on the ordinary path,
   * so existing clients that don't check for it see no behavior change.
   * Call POST /trading/orders/:id/retry-matching to recover.
   */
  matchingDeferred?: true;
};

@Controller("trading")
export class TradingController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly positionsService: PositionsService,
    private readonly orderBookService: OrderBookService,
  ) {}

  @Post("orders")
  @UseGuards(JwtAuthGuard)
  async createOrder(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto): Promise<OrderPlacementResponse> {
    try {
      const order = await this.ordersService.create(user.id, dto);
      return await this.ordersService.getPlacementSummary(user.id, order.id);
    } catch (error) {
      return this.handleDeferredMatching(user.id, error);
    }
  }

  // Order placement itself already succeeded by the time this can throw
  // (see MatchingAttemptFailedException's docblock) — so this reports the
  // order's real, current DB state plus an honest "matching didn't
  // complete" flag, instead of surfacing an HTTP error for a placement
  // that did not actually fail.
  private async handleDeferredMatching(userId: string, error: unknown): Promise<OrderPlacementResponse> {
    if (!(error instanceof MatchingAttemptFailedException)) {
      throw error;
    }
    const summary = await this.ordersService.getPlacementSummary(userId, error.orderId);
    return { ...summary, matchingDeferred: true };
  }

  @Post("orders/:id/retry-matching")
  @UseGuards(JwtAuthGuard)
  async retryMatching(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): Promise<OrderPlacementResponse> {
    try {
      return await this.ordersService.retryMatching(user.id, id);
    } catch (error) {
      return this.handleDeferredMatching(user.id, error);
    }
  }

  @Post("orders/:id/cancel")
  @UseGuards(JwtAuthGuard)
  cancelOrder(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.ordersService.cancel(user.id, id);
  }

  @Get("orders/:id")
  @UseGuards(JwtAuthGuard)
  getOrder(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.ordersService.getOwnOrder(user.id, id);
  }

  @Get("orders")
  @UseGuards(JwtAuthGuard)
  myOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.listMine(user.id);
  }

  @Get("positions")
  @UseGuards(JwtAuthGuard)
  myPositions(@CurrentUser() user: AuthenticatedUser) {
    return this.positionsService.listMine(user.id);
  }

  // Public — no auth required, aggregated price levels only (no user data).
  @Get("markets/:marketId/outcomes/:outcomeId/book")
  getOrderBook(@Param("marketId") marketId: string, @Param("outcomeId") outcomeId: string) {
    return this.orderBookService.getBook(marketId, outcomeId);
  }
}
