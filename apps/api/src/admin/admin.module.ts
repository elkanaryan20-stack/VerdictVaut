import { Module } from "@nestjs/common";
import { WalletModule } from "../wallet/wallet.module";
import { AdminController } from "./admin.controller";
import { AuditLogService } from "./audit-log.service";

@Module({
  imports: [WalletModule],
  controllers: [AdminController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AdminModule {}
