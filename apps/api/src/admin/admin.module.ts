import { Module } from "@nestjs/common";
import { WalletModule } from "../wallet/wallet.module";
import { AdminController } from "./admin.controller";

@Module({
  imports: [WalletModule],
  controllers: [AdminController],
})
export class AdminModule {}
