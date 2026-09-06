import { Module } from "@nestjs/common";
import { LedgerModule } from "../ledger/ledger.module";
import { AssetsNetworksController } from "./assets-networks/assets-networks.controller";
import { AssetsNetworksService } from "./assets-networks/assets-networks.service";
import { DepositAddressService } from "./addresses/deposit-address.service";
import { BalancesController } from "./balances/balances.controller";
import { BalancesService } from "./balances/balances.service";
import { BitcoinDepositAdapter } from "./chain-adapters/bitcoin/bitcoin-deposit-adapter";
import { DepositChainAdapterFactory } from "./chain-adapters/deposit-chain-adapter.factory";
import { EvmDepositAdapter } from "./chain-adapters/evm/evm-deposit-adapter";
import { ChainRpcConfigService } from "./chain-adapters/rpc-config.service";
import { SolanaDepositAdapter } from "./chain-adapters/solana/solana-deposit-adapter";
import { XrpDepositAdapter } from "./chain-adapters/xrp/xrp-deposit-adapter";
import { ConfirmationPolicyService } from "./confirmation/confirmation-policy.service";
import { CustodyProviderFactory } from "./custody/custody-provider.factory";
import { BitcoinCustodyProvider } from "./custody/providers/bitcoin-custody.provider";
import { EvmCustodyProvider } from "./custody/providers/evm-custody.provider";
import { SolanaCustodyProvider } from "./custody/providers/solana-custody.provider";
import { XrpCustodyProvider } from "./custody/providers/xrp-custody.provider";
import { DepositsController } from "./deposits/deposits.controller";
import { DepositsService } from "./deposits/deposits.service";
import { ManualBroadcastExecutor } from "./executors/manual-broadcast.executor";
import { ProductionCustodyExecutor } from "./executors/production-custody.executor";
import { WithdrawalExecutorFactory } from "./executors/withdrawal-executor.factory";
import { WithdrawalsController } from "./withdrawals/withdrawals.controller";
import { WithdrawalsService } from "./withdrawals/withdrawals.service";
import { ReconciliationService } from "./reconciliation/reconciliation.service";
import { DepositReprocessingService } from "./watchers/deposit-reprocessing.service";
import { DepositWatcherService } from "./watchers/deposit-watcher.service";

@Module({
  imports: [LedgerModule],
  controllers: [AssetsNetworksController, BalancesController, DepositsController, WithdrawalsController],
  providers: [
    AssetsNetworksService,
    BalancesService,
    DepositAddressService,
    DepositsService,
    WithdrawalsService,
    ManualBroadcastExecutor,
    ProductionCustodyExecutor,
    WithdrawalExecutorFactory,
    ReconciliationService,
    ChainRpcConfigService,
    ConfirmationPolicyService,
    BitcoinDepositAdapter,
    EvmDepositAdapter,
    SolanaDepositAdapter,
    XrpDepositAdapter,
    DepositChainAdapterFactory,
    BitcoinCustodyProvider,
    EvmCustodyProvider,
    SolanaCustodyProvider,
    XrpCustodyProvider,
    CustodyProviderFactory,
    DepositWatcherService,
    DepositReprocessingService,
  ],
  exports: [
    AssetsNetworksService,
    DepositAddressService,
    DepositsService,
    WithdrawalsService,
    ReconciliationService,
    DepositChainAdapterFactory,
    ConfirmationPolicyService,
    DepositReprocessingService,
  ],
})
export class WalletModule {}
