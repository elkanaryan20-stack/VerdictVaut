import { Module } from "@nestjs/common";
import { SettlementModule } from "../settlement/settlement.module";
import { UsersModule } from "../users/users.module";
import { ScheduledJobStateModule } from "../operations/scheduled-job-state.module";
import { WalletModule } from "../wallet/wallet.module";
import { AdminController } from "./admin.controller";

@Module({
  imports: [WalletModule, SettlementModule, UsersModule, ScheduledJobStateModule],
  controllers: [AdminController],
})
export class AdminModule {}
