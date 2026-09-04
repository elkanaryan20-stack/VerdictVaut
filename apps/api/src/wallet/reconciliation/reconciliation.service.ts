import { Injectable, NotFoundException } from "@nestjs/common";
import { ReconciliationStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Reconciliation compares ledger-derived expectations against real
 * chain/provider state. No CustodyProvider implementation is wired up
 * yet (see custody-provider.interface.ts), so a run today can only be
 * honestly recorded as unavailable — it must never report a fabricated
 * "OK". Once a real provider is registered per asset/network, this is
 * the place that calls it.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async run(assetNetworkId: string) {
    const assetNetwork = await this.prisma.assetNetwork.findUnique({ where: { id: assetNetworkId } });
    if (!assetNetwork) {
      throw new NotFoundException("Asset/network pair not found");
    }

    return this.prisma.reconciliationRun.create({
      data: {
        assetNetworkId,
        status: ReconciliationStatus.ERROR,
        notes: "No CustodyProvider implementation is registered for this asset/network yet — nothing to reconcile against.",
      },
    });
  }

  async listRuns(assetNetworkId: string) {
    return this.prisma.reconciliationRun.findMany({
      where: { assetNetworkId },
      orderBy: { runAt: "desc" },
      take: 50,
    });
  }
}
