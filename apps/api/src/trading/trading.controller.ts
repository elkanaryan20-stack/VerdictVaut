import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { CreateOrderDto } from "./dto/create-order.dto";
import { OrderBookService } from "./order-book/order-book.service";
import { OrdersService } from "./orders.service";
import { PositionsService } from "./positions/positions.service";

@Controller("trading")
export class TradingController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly positionsService: PositionsService,
    private readonly orderBookService: OrderBookService,
  ) {}

  @Post("orders")
  @UseGuards(JwtAuthGuard)
  createOrder(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(user.id, dto);
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
