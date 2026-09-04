import { Module } from "@nestjs/common";
import { OrdersService } from "./orders.service";
import { TradingController } from "./trading.controller";

@Module({
  controllers: [TradingController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class TradingModule {}
