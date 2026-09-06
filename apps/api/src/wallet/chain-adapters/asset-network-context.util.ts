import { NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AssetNetworkContext } from "./deposit-chain-adapter.interface";

/** Shared by DepositChainAdapterFactory and CustodyProviderFactory — one place that turns an AssetNetwork row into the context adapters/providers actually need. */
export async function resolveAssetNetworkContext(prisma: PrismaService, assetNetworkId: string): Promise<AssetNetworkContext> {
  const assetNetwork = await prisma.assetNetwork.findUnique({
    where: { id: assetNetworkId },
    include: { asset: true, network: true },
  });
  if (!assetNetwork) {
    throw new NotFoundException(`AssetNetwork ${assetNetworkId} not found`);
  }

  return {
    assetNetworkId: assetNetwork.id,
    assetSymbol: assetNetwork.asset.symbol,
    assetDecimals: assetNetwork.asset.decimals,
    networkFamily: assetNetwork.network.family,
    networkCode: assetNetwork.network.code,
    contractAddress: assetNetwork.contractAddress,
    isNative: assetNetwork.isNative,
    memoRequired: assetNetwork.memoRequired,
  };
}
