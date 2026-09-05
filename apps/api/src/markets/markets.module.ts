import { Module } from "@nestjs/common";
import { SettlementModule } from "../settlement/settlement.module";
import { TradingModule } from "../trading/trading.module";
import { MarketsController } from "./markets.controller";
import { MarketsService } from "./markets.service";
import { ResolutionService } from "./resolution/resolution.service";

@Module({
  imports: [TradingModule, SettlementModule],
  controllers: [MarketsController],
  providers: [MarketsService, ResolutionService],
  exports: [MarketsService, ResolutionService],
})
export class MarketsModule {}
