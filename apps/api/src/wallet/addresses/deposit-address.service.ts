import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, WalletAddressStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { SerializableTransactionRunner } from "../../prisma/serializable-transaction-runner";

interface ClaimedAddressRow {
  id: string;
  destinationTag: string | null;
  environment: "SANDBOX" | "PRODUCTION";
}

/**
 * Assigns a stable, dedicated deposit address per (user, asset, network)
 * from a pre-provisioned pool. Never generates an address on the fly —
 * if the pool is empty, provisioning more addresses is an admin action,
 * not something this service papers over.
 */
@Injectable()
export class DepositAddressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: SerializableTransactionRunner,
  ) {}

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

    return this.txRunner.run(async (tx) => {
      // Re-check inside the transaction: two concurrent calls for the
      // same user could both have missed the fast-path check above.
      const existingInTx = await tx.depositAddressAssignment.findUnique({
        where: { userId_assetId_networkId: { userId, assetId: asset.id, networkId: network.id } },
        include: { walletAddress: true },
      });
      if (existingInTx) {
        return existingInTx;
      }

      // Atomically claim one AVAILABLE address: SKIP LOCKED means two
      // concurrent claims for the same asset/network never contend for
      // the same row — each gets a distinct address (or a deterministic
      // "pool exhausted" failure), with no unguarded read-then-write gap.
      const claimed = await tx.$queryRaw<ClaimedAddressRow[]>(Prisma.sql`
        UPDATE "wallet_addresses"
        SET "status" = ${WalletAddressStatus.ASSIGNED}::"WalletAddressStatus", "updatedAt" = NOW()
        WHERE "id" = (
          SELECT "id" FROM "wallet_addresses"
          WHERE "assetNetworkId" = ${assetNetwork.id}
            AND "status" = ${WalletAddressStatus.AVAILABLE}::"WalletAddressStatus"
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "id", "destinationTag", "environment"
      `);

      if (claimed.length === 0) {
        throw new BadRequestException(
          `No available deposit address for ${assetSymbol} on ${networkCode} — an admin needs to provision more.`,
        );
      }

      const availableAddress = claimed[0];

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
