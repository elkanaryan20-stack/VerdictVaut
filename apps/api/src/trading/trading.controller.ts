import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser, AuthenticatedUser } from "../common/decorators/current-user.decorator";
import { CreateOrderDto } from "./dto/create-order.dto";
import { OrdersService } from "./orders.service";

@Controller("trading")
@UseGuards(JwtAuthGuard)
export class TradingController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post("orders")
  createOrder(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(user.id, dto);
  }

  @Post("orders/:id/cancel")
  cancelOrder(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.ordersService.cancel(user.id, id);
  }

  @Get("orders")
  myOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.listMine(user.id);
  }

  @Get("positions")
  myPositions(@CurrentUser() user: AuthenticatedUser) {
    return this.ordersService.listMyPositions(user.id);
  }
}
