import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class AssetsNetworksService {
  constructor(private readonly prisma: PrismaService) {}

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
    const assetNetwork = await this.prisma.assetNetwork.findUnique({ where: { id: assetNetworkId } });
    if (!assetNetwork) {
      throw new NotFoundException("Asset/network pair not found");
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
