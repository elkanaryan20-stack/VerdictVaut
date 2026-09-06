import { Injectable } from "@nestjs/common";
import { NetworkFamily } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { resolveAssetNetworkContext } from "../chain-adapters/asset-network-context.util";
import { CustodyProvider } from "./custody-provider.interface";
import { BitcoinCustodyProvider } from "./providers/bitcoin-custody.provider";
import { EvmCustodyProvider } from "./providers/evm-custody.provider";
import { SolanaCustodyProvider } from "./providers/solana-custody.provider";
import { XrpCustodyProvider } from "./providers/xrp-custody.provider";

/** Resolves which CustodyProvider handles a given AssetNetwork's read-only chain queries — mirrors DepositChainAdapterFactory. */
@Injectable()
export class CustodyProviderFactory {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bitcoin: BitcoinCustodyProvider,
    private readonly evm: EvmCustodyProvider,
    private readonly solana: SolanaCustodyProvider,
    private readonly xrp: XrpCustodyProvider,
  ) {}

  async resolve(assetNetworkId: string): Promise<CustodyProvider> {
    const network = await resolveAssetNetworkContext(this.prisma, assetNetworkId);
    switch (network.networkFamily) {
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
}
