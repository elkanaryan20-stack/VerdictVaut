import { Injectable } from "@nestjs/common";
import { WithdrawalExecutorType } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ManualBroadcastExecutor } from "./manual-broadcast.executor";
import { ProductionCustodyExecutor } from "./production-custody.executor";
import { WithdrawalExecutor } from "./withdrawal-executor.interface";

/**
 * Resolves which WithdrawalExecutor handles a given asset/network,
 * driven by WithdrawalExecutionConfig — not by an environment check
 * scattered through the codebase. No config row for an asset/network
 * means it defaults to manual broadcast, the safe sandbox behavior.
 */
@Injectable()
export class WithdrawalExecutorFactory {
  constructor(
    private readonly prisma: PrismaService,
    private readonly manualBroadcastExecutor: ManualBroadcastExecutor,
    private readonly productionCustodyExecutor: ProductionCustodyExecutor,
  ) {}

  async resolve(assetNetworkId: string): Promise<WithdrawalExecutor> {
    const config = await this.prisma.withdrawalExecutionConfig.findUnique({
      where: { assetNetworkId },
    });

    if (config?.executorType === WithdrawalExecutorType.PRODUCTION_CUSTODY) {
      return this.productionCustodyExecutor;
    }
    return this.manualBroadcastExecutor;
  }
}
