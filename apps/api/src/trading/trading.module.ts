import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { OrderBookService } from "./order-book/order-book.service";
import { OrdersService } from "./orders.service";
import { FEE_CALCULATOR } from "./fees/fee-calculator.interface";
import { ZeroFeeCalculator } from "./fees/zero-fee.calculator";
import { MATCHING_ENGINE } from "./matching/matching-engine.interface";
import { NotImplementedMatchingEngine } from "./matching/not-implemented-matching-engine";
import { PositionReservationService } from "./positions/position-reservation.service";
import { PositionsService } from "./positions/positions.service";
import { OrderRiskValidator } from "./risk/order-risk-validator.service";
import { TradingController } from "./trading.controller";

@Module({
  imports: [LedgerModule],
  controllers: [TradingController],
  providers: [
    OrdersService,
    PositionReservationService,
    PositionsService,
    OrderRiskValidator,
    OrderBookService,
    { provide: FEE_CALCULATOR, useClass: ZeroFeeCalculator },
    { provide: MATCHING_ENGINE, useClass: NotImplementedMatchingEngine },
  ],
  exports: [OrdersService, PositionReservationService, PositionsService],
})
export class TradingModule {}
