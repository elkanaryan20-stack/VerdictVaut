import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { OrderStatus } from "@prisma/client";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { RequireActiveUser } from "../common/decorators/require-active-user.decorator";
import { ActiveUserGuard } from "../common/guards/active-user.guard";
import { TRADING_THROTTLE } from "../common/throttle-presets";
import { CreateOrderDto } from "./dto/create-order.dto";
import { FillsService } from "./fills/fills.service";
import { OrderBookService } from "./order-book/order-book.service";
import { OrderPlacementResult, OrdersService, toOrderView } from "./orders.service";
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
    private readonly fillsService: FillsService,
  ) {}

  // Phase 20 security-gate remediation — the declarative, route-visible
  // half of "an unverified account can never open a new position"; the
  // pre-existing check inside OrdersService.create() itself remains as
  // defense-in-depth (see ActiveUserGuard's own docblock).
  @Post("orders")
  @UseGuards(JwtAuthGuard, ActiveUserGuard)
  @RequireActiveUser()
  @Throttle(TRADING_THROTTLE)
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

  // Deliberately NOT @RequireActiveUser() — this only resumes matching
  // for an order that already exists (which requires having been ACTIVE
  // at creation time, since createOrder above is gated); it never
  // creates new financial exposure a still-ACTIVE check would need to
  // prevent (see Phase 20 security-gate audit).
  @Post("orders/:id/retry-matching")
  @UseGuards(JwtAuthGuard)
  @Throttle(TRADING_THROTTLE)
  async retryMatching(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string): Promise<OrderPlacementResponse> {
    try {
      return await this.ordersService.retryMatching(user.id, id);
    } catch (error) {
      return this.handleDeferredMatching(user.id, error);
    }
  }

  // Projected through toOrderView() — a raw Order carries `sequence` as a
  // native bigint, which JSON.stringify cannot serialize at all (throws,
  // not just leaks); it's also an internal tie-breaker clients must never
  // read as an ordering signal (see Order.sequence's docblock).
  // Deliberately NOT @RequireActiveUser() — cancellation only reduces
  // existing exposure, never creates it; there is also no code path that
  // ever moves an account from ACTIVE back to PENDING_VERIFICATION, so a
  // non-ACTIVE user could never legitimately have an order to cancel in
  // the first place (see Phase 20 security-gate audit).
  @Post("orders/:id/cancel")
  @UseGuards(JwtAuthGuard)
  @Throttle(TRADING_THROTTLE)
  async cancelOrder(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return toOrderView(await this.ordersService.cancel(user.id, id));
  }

  @Get("orders/:id")
  @UseGuards(JwtAuthGuard)
  async getOrder(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return toOrderView(await this.ordersService.getOwnOrder(user.id, id));
  }

  @Get("orders")
  @UseGuards(JwtAuthGuard)
  myOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("marketId") marketId?: string,
    @Query("status") status?: string,
  ) {
    if (status !== undefined && !Object.values(OrderStatus).includes(status as OrderStatus)) {
      throw new BadRequestException(`Invalid status filter '${status}'`);
    }
    return this.ordersService.listMine(user.id, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      marketId,
      status: status as OrderStatus | undefined,
    });
  }

  @Get("positions")
  @UseGuards(JwtAuthGuard)
  myPositions(@CurrentUser() user: AuthenticatedUser) {
    return this.positionsService.listMine(user.id);
  }

  @Get("fills")
  @UseGuards(JwtAuthGuard)
  myFills(
    @CurrentUser() user: AuthenticatedUser,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("marketId") marketId?: string,
  ) {
    return this.fillsService.listMine(user.id, {
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      marketId,
    });
  }

  // Public — no auth required, aggregated price levels only (no user data).
  @Get("markets/:marketId/outcomes/:outcomeId/book")
  getOrderBook(@Param("marketId") marketId: string, @Param("outcomeId") outcomeId: string) {
    return this.orderBookService.getBook(marketId, outcomeId);
  }
}
