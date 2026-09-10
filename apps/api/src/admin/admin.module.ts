import { Module } from "@nestjs/common";
import { SettlementModule } from "../settlement/settlement.module";
import { WalletModule } from "../wallet/wallet.module";
import { AdminController } from "./admin.controller";

@Module({
  imports: [WalletModule, SettlementModule],
  controllers: [AdminController],
})
export class AdminModule {}
