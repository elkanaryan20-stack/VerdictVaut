import { Module } from "@nestjs/common";
import { SettlementModule } from "../settlement/settlement.module";
import { WalletModule } from "../wallet/wallet.module";
import { ReconciliationSchedulerService } from "./reconciliation-scheduler.service";
import { ScheduledJobStateModule } from "./scheduled-job-state.module";

/** Phase 35 — worker-side operational jobs (see ReconciliationSchedulerService). Imported by AppModule; the scheduler itself stays idle unless RECONCILIATION_SCHEDULER_ENABLED=true, and the API process refuses to boot with that set (watcher-boundary.guard.ts). */
@Module({
  imports: [WalletModule, SettlementModule, ScheduledJobStateModule],
  providers: [ReconciliationSchedulerService],
  exports: [ReconciliationSchedulerService],
})
export class OperationsModule {}
