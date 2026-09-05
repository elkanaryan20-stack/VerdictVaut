import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { SettlementService } from "./settlement.service";

@Module({
  imports: [LedgerModule],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
