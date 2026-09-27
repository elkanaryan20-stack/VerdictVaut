import { Module } from "@nestjs/common";
import { ScheduledJobStateService } from "./scheduled-job-state.service";

/** Standalone so WalletModule (withdrawal watcher heartbeat), OperationsModule (scheduler) and AdminModule (visibility) can all depend on it without a module cycle. */
@Module({
  providers: [ScheduledJobStateService],
  exports: [ScheduledJobStateService],
})
export class ScheduledJobStateModule {}
