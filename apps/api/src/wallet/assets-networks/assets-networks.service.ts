import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ChainRpcConfigService } from "../chain-adapters/rpc-config.service";

@Injectable()
export class AssetsNetworksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rpcConfig: ChainRpcConfigService,
  ) {}

  async listAssets() {
    return this.prisma.asset.findMany({ orderBy: { symbol: "asc" } });
  }

  async listNetworks() {
    return this.prisma.network.findMany({ orderBy: { code: "asc" } });
  }

  /** Active asset/network combinations available for deposit/withdrawal — what the frontend renders. */
  async listActiveAssetNetworks() {
    return this.prisma.assetNetwork.findMany({
      where: { isActive: true, asset: { isActive: true }, network: { isActive: true } },
      include: { asset: true, network: true },
    });
  }

  async setAssetActive(assetId: string, isActive: boolean) {
    return this.prisma.asset.update({ where: { id: assetId }, data: { isActive } });
  }

  async setNetworkActive(networkId: string, isActive: boolean) {
    return this.prisma.network.update({ where: { id: networkId }, data: { isActive } });
  }

  async setAssetNetworkActive(assetNetworkId: string, isActive: boolean) {
    const assetNetwork = await this.prisma.assetNetwork.findUnique({ where: { id: assetNetworkId }, include: { network: true } });
    if (!assetNetwork) {
      throw new NotFoundException("Asset/network pair not found");
    }
    // A non-native asset/network with no contract address would otherwise
    // only surface as a scan-time failure in the deposit watcher (each
    // adapter's own validateNetwork throws there — see e.g.
    // EvmDepositAdapter/SolanaDepositAdapter) — much later and less
    // actionable than rejecting it immediately here (Phase 11 finding).
    // Backed by asset_networks_active_token_requires_contract_check at
    // the DB level too (Phase 14A) — this check stays for the clearer,
    // immediate error message a direct API caller sees.
    if (isActive && !assetNetwork.isNative && !assetNetwork.contractAddress) {
      throw new BadRequestException("Cannot activate a non-native asset/network with no contractAddress configured");
    }
    // Phase 14A: catches "incomplete blockchain watcher configuration"
    // (section 5) at activation time rather than letting it surface only
    // when the next scan poll fails — an asset/network with no resolvable
    // RPC/provider URL is not safely observable for deposits yet.
    // Re-thrown as BadRequestException: ChainRpcConfigService's own
    // ServiceUnavailableException is the right signal for a live runtime
    // call failing, but this is a config-time validation, not an outage.
    if (isActive) {
      try {
        this.rpcConfig.getRpcUrl(assetNetwork.network.code);
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
    }
    return this.prisma.assetNetwork.update({ where: { id: assetNetworkId }, data: { isActive } });
  }

  async createAssetNetwork(params: {
    assetSymbol: string;
    networkCode: string;
    isNative: boolean;
    contractAddress?: string;
    memoRequired?: boolean;
    minConfirmations: number;
    depositMinAmount?: string;
    withdrawalMinAmount?: string;
  }) {
    const asset = await this.prisma.asset.findUnique({ where: { symbol: params.assetSymbol } });
    const network = await this.prisma.network.findUnique({ where: { code: params.networkCode } });
    if (!asset || !network) {
      throw new BadRequestException("Unknown asset symbol or network code");
    }
    if (!params.isNative && !params.contractAddress) {
      throw new BadRequestException("A non-native asset/network requires a contractAddress");
    }

    return this.prisma.assetNetwork.create({
      data: {
        assetId: asset.id,
        networkId: network.id,
        isNative: params.isNative,
        contractAddress: params.contractAddress,
        memoRequired: params.memoRequired ?? false,
        minConfirmations: params.minConfirmations,
        depositMinAmount: params.depositMinAmount ?? "0",
        withdrawalMinAmount: params.withdrawalMinAmount ?? "0",
      },
    });
  }
}
