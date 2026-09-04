import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { OrdersService } from "./orders.service";
import { TradingController } from "./trading.controller";

@Module({
  imports: [LedgerModule],
  controllers: [TradingController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class TradingModule {}
