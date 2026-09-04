import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, WalletAddressStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Assigns a stable, dedicated deposit address per (user, asset, network)
 * from a pre-provisioned pool. Never generates an address on the fly —
 * if the pool is empty, provisioning more addresses is an admin action,
 * not something this service papers over.
 */
@Injectable()
export class DepositAddressService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrAssign(userId: string, assetSymbol: string, networkCode: string) {
    const asset = await this.prisma.asset.findUnique({ where: { symbol: assetSymbol } });
    const network = await this.prisma.network.findUnique({ where: { code: networkCode } });
    if (!asset || !network) {
      throw new BadRequestException("Unknown asset symbol or network code");
    }

    const assetNetwork = await this.prisma.assetNetwork.findUnique({
      where: { assetId_networkId: { assetId: asset.id, networkId: network.id } },
    });
    if (!assetNetwork || !assetNetwork.isActive) {
      throw new BadRequestException(`${assetSymbol} is not currently supported on ${networkCode}`);
    }

    const existing = await this.prisma.depositAddressAssignment.findUnique({
      where: { userId_assetId_networkId: { userId, assetId: asset.id, networkId: network.id } },
      include: { walletAddress: true },
    });
    if (existing) {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
      const availableAddress = await tx.walletAddress.findFirst({
        where: { assetNetworkId: assetNetwork.id, status: WalletAddressStatus.AVAILABLE },
        orderBy: { createdAt: "asc" },
      });

      if (!availableAddress) {
        throw new BadRequestException(
          `No available deposit address for ${assetSymbol} on ${networkCode} — an admin needs to provision more.`,
        );
      }

      await tx.walletAddress.update({
        where: { id: availableAddress.id },
        data: { status: WalletAddressStatus.ASSIGNED },
      });

      return tx.depositAddressAssignment.create({
        data: {
          userId,
          assetId: asset.id,
          networkId: network.id,
          assetNetworkId: assetNetwork.id,
          walletAddressId: availableAddress.id,
          destinationTag: availableAddress.destinationTag,
          environment: availableAddress.environment,
        },
        include: { walletAddress: true },
      });
    });
  }

  async listMine(userId: string) {
    return this.prisma.depositAddressAssignment.findMany({
      where: { userId },
      include: { walletAddress: true, asset: true, network: true },
    });
  }

  async provisionAddress(params: {
    assetNetworkId: string;
    address: string;
    destinationTag?: string;
    environment: "SANDBOX" | "PRODUCTION";
    metadata?: Record<string, unknown>;
  }) {
    const assetNetwork = await this.prisma.assetNetwork.findUnique({ where: { id: params.assetNetworkId } });
    if (!assetNetwork) {
      throw new NotFoundException("Asset/network pair not found");
    }

    return this.prisma.walletAddress.create({
      data: {
        assetNetworkId: params.assetNetworkId,
        address: params.address,
        destinationTag: params.destinationTag,
        environment: params.environment,
        status: WalletAddressStatus.AVAILABLE,
        metadata: params.metadata as Prisma.InputJsonValue,
      },
    });
  }
}
