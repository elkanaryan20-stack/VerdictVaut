import { Module } from "@nestjs/common";
import { WalletModule } from "../wallet/wallet.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [WalletModule],
  controllers: [HealthController],
})
export class HealthModule {}
