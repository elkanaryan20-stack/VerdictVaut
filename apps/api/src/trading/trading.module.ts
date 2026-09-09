import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { ExecutionCoordinator } from "./execution/execution-coordinator.service";
import { FillsService } from "./fills/fills.service";
import { OrderBookService } from "./order-book/order-book.service";
import { OrdersService } from "./orders.service";
import { FEE_CALCULATOR } from "./fees/fee-calculator.interface";
import { ZeroFeeCalculator } from "./fees/zero-fee.calculator";
import { COMPLETE_SET_MINT_ENGINE } from "./matching/complete-set-mint-engine.interface";
import { PriceTimePriorityCompleteSetMintEngine } from "./matching/complete-set-mint-engine";
import { MATCHING_ENGINE } from "./matching/matching-engine.interface";
import { PriceTimePriorityMatchingEngine } from "./matching/price-time-priority-matching-engine";
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
    ExecutionCoordinator,
    FillsService,
    { provide: FEE_CALCULATOR, useClass: ZeroFeeCalculator },
    { provide: MATCHING_ENGINE, useClass: PriceTimePriorityMatchingEngine },
    { provide: COMPLETE_SET_MINT_ENGINE, useClass: PriceTimePriorityCompleteSetMintEngine },
  ],
  exports: [OrdersService, PositionReservationService, PositionsService, ExecutionCoordinator, FillsService],
})
export class TradingModule {}
