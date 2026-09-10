import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { CollateralReconciliationService } from "./collateral-reconciliation.service";
import { SettlementService } from "./settlement.service";

@Module({
  imports: [LedgerModule],
  providers: [SettlementService, CollateralReconciliationService],
  exports: [SettlementService, CollateralReconciliationService],
})
export class SettlementModule {}
