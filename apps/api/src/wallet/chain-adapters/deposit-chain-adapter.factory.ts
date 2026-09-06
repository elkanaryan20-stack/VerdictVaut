import { Injectable } from "@nestjs/common";
import { NetworkFamily } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { resolveAssetNetworkContext } from "./asset-network-context.util";
import { BitcoinDepositAdapter } from "./bitcoin/bitcoin-deposit-adapter";
import { AssetNetworkContext, BlockchainDepositAdapter } from "./deposit-chain-adapter.interface";
import { EvmDepositAdapter } from "./evm/evm-deposit-adapter";
import { SolanaDepositAdapter } from "./solana/solana-deposit-adapter";
import { XrpDepositAdapter } from "./xrp/xrp-deposit-adapter";

/**
 * Resolves which BlockchainDepositAdapter handles a given AssetNetwork,
 * driven by Network.family — mirrors WithdrawalExecutorFactory's
 * "configuration picks the implementation" shape. BTC, EVM, Solana, and
 * XRP each get their own adapter rather than one universal
 * implementation, since their transaction models are materially
 * different (see deposit-chain-adapter.interface.ts).
 */
@Injectable()
export class DepositChainAdapterFactory {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bitcoin: BitcoinDepositAdapter,
    private readonly evm: EvmDepositAdapter,
    private readonly solana: SolanaDepositAdapter,
    private readonly xrp: XrpDepositAdapter,
  ) {}

  private adapterFor(family: NetworkFamily): BlockchainDepositAdapter {
    switch (family) {
      case NetworkFamily.BITCOIN:
        return this.bitcoin;
      case NetworkFamily.EVM:
        return this.evm;
      case NetworkFamily.SOLANA:
        return this.solana;
      case NetworkFamily.XRPL:
        return this.xrp;
    }
  }

  async resolve(assetNetworkId: string): Promise<{ adapter: BlockchainDepositAdapter; network: AssetNetworkContext }> {
    const network = await resolveAssetNetworkContext(this.prisma, assetNetworkId);
    return { adapter: this.adapterFor(network.networkFamily), network };
  }
}
