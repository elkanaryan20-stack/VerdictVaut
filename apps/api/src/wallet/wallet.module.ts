import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { AssetsNetworksController } from "./assets-networks/assets-networks.controller";
import { AssetsNetworksService } from "./assets-networks/assets-networks.service";
import { DepositAddressService } from "./addresses/deposit-address.service";
import { DepositsController } from "./deposits/deposits.controller";
import { DepositsService } from "./deposits/deposits.service";
import { ManualBroadcastExecutor } from "./executors/manual-broadcast.executor";
import { ProductionCustodyExecutor } from "./executors/production-custody.executor";
import { WithdrawalExecutorFactory } from "./executors/withdrawal-executor.factory";
import { WithdrawalsController } from "./withdrawals/withdrawals.controller";
import { WithdrawalsService } from "./withdrawals/withdrawals.service";
import { ReconciliationService } from "./reconciliation/reconciliation.service";

@Module({
  imports: [LedgerModule],
  controllers: [AssetsNetworksController, DepositsController, WithdrawalsController],
  providers: [
    AssetsNetworksService,
    DepositAddressService,
    DepositsService,
    WithdrawalsService,
    ManualBroadcastExecutor,
    ProductionCustodyExecutor,
    WithdrawalExecutorFactory,
    ReconciliationService,
  ],
  exports: [
    AssetsNetworksService,
    DepositAddressService,
    DepositsService,
    WithdrawalsService,
    ReconciliationService,
  ],
})
export class WalletModule {}
