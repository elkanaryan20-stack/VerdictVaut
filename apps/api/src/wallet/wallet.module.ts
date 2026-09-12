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
import { FireblocksCustodyAdapter } from "./executors/fireblocks/fireblocks-custody.adapter";
import { FireblocksWebhookController } from "./executors/fireblocks/fireblocks-webhook.controller";
import { FireblocksWebhookService } from "./executors/fireblocks/fireblocks-webhook.service";
import { ManualBroadcastExecutor } from "./executors/manual-broadcast.executor";
import { ProductionCustodyExecutor } from "./executors/production-custody.executor";
import { WithdrawalExecutorFactory } from "./executors/withdrawal-executor.factory";
import { ComplianceGateFactory } from "./withdrawals/compliance/compliance-gate.factory";
import { DeferredComplianceGate } from "./withdrawals/compliance/deferred-compliance-gate";
import { EllipticAddressRiskGate } from "./withdrawals/compliance/elliptic/elliptic-address-risk.gate";
import { WITHDRAWAL_COMPLIANCE_GATE } from "./withdrawals/compliance/withdrawal-compliance-gate.interface";
import { ProductionSafetyGate } from "./production-safety.gate";
import { CustodyProviderConfigService } from "./provider-config/custody-provider-config.service";
import { ComplianceProviderConfigService } from "./provider-config/compliance-provider-config.service";
import { SecretResolverService } from "./provider-config/secret-resolver.service";
import { WITHDRAWAL_FEE_CALCULATOR } from "./withdrawals/fees/withdrawal-fee-calculator.interface";
import { ZeroWithdrawalFeeCalculator } from "./withdrawals/fees/zero-withdrawal-fee.calculator";
import { WithdrawalsController } from "./withdrawals/withdrawals.controller";
import { WithdrawalsService } from "./withdrawals/withdrawals.service";
import { ReconciliationService } from "./reconciliation/reconciliation.service";
import { IndependentReconciliationService } from "./reconciliation/independent-reconciliation.service";
import { DepositReprocessingService } from "./watchers/deposit-reprocessing.service";
import { DepositWatcherService } from "./watchers/deposit-watcher.service";
import { WithdrawalWatcherService } from "./watchers/withdrawal-watcher.service";

@Module({
  imports: [LedgerModule],
  controllers: [AssetsNetworksController, BalancesController, DepositsController, WithdrawalsController, FireblocksWebhookController],
  providers: [
    AssetsNetworksService,
    BalancesService,
    DepositAddressService,
    DepositsService,
    WithdrawalsService,
    ManualBroadcastExecutor,
    ProductionCustodyExecutor,
    FireblocksCustodyAdapter,
    FireblocksWebhookService,
    SecretResolverService,
    WithdrawalExecutorFactory,
    ReconciliationService,
    IndependentReconciliationService,
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
    WithdrawalWatcherService,
    { provide: WITHDRAWAL_FEE_CALCULATOR, useClass: ZeroWithdrawalFeeCalculator },
    DeferredComplianceGate,
    EllipticAddressRiskGate,
    { provide: WITHDRAWAL_COMPLIANCE_GATE, useClass: ComplianceGateFactory },
    ProductionSafetyGate,
    CustodyProviderConfigService,
    ComplianceProviderConfigService,
  ],
  exports: [
    AssetsNetworksService,
    DepositAddressService,
    DepositsService,
    WithdrawalsService,
    ReconciliationService,
    IndependentReconciliationService,
    DepositChainAdapterFactory,
    ConfirmationPolicyService,
    DepositReprocessingService,
    DepositWatcherService,
    WithdrawalWatcherService,
    CustodyProviderConfigService,
    ComplianceProviderConfigService,
    FireblocksWebhookService,
  ],
})
export class WalletModule {}
