import { Module } from "@nestjs/common";
import { SettlementModule } from "../settlement/settlement.module";
import { UsersModule } from "../users/users.module";
import { WalletModule } from "../wallet/wallet.module";
import { AdminController } from "./admin.controller";

@Module({
  imports: [WalletModule, SettlementModule, UsersModule],
  controllers: [AdminController],
})
export class AdminModule {}
