import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WithdrawalExecutorType } from "@prisma/client";
import { AppConfig } from "../../config/configuration";
import { PrismaService } from "../../prisma/prisma.service";
import { ManualBroadcastExecutor } from "./manual-broadcast.executor";
import { ProductionCustodyExecutor } from "./production-custody.executor";
import { WithdrawalExecutor } from "./withdrawal-executor.interface";

/**
 * Resolves which WithdrawalExecutor handles a given asset/network,
 * driven by WithdrawalExecutionConfig — not by an environment check
 * scattered through the codebase. No config row for an asset/network
 * means it defaults to manual broadcast, the safe sandbox behavior —
 * EXCEPT in production (see below), where defaulting to manual broadcast
 * would silently route real-money custody through a path that performs
 * no signing/broadcast at all, leaving withdrawals stuck forever with no
 * real execution ever happening. That failure mode is exactly the
 * "silent fallback to development behavior" requirement #9 forbids, so
 * production instead fails loudly and immediately: a real
 * WithdrawalExecutionConfig row explicitly selecting PRODUCTION_CUSTODY
 * is REQUIRED for every asset/network before it can be withdrawn from
 * in production. Belt-and-suspenders alongside the top-level boot gate
 * (env.validation.ts already refuses to start at all with
 * APP_ENVIRONMENT=production, since no real custody provider is
 * integrated yet — see ProductionCustodyExecutor) — this check keeps the
 * same guarantee at the layer that actually picks an executor, so it
 * holds even if that boot gate is ever relaxed independently.
 */
@Injectable()
export class WithdrawalExecutorFactory {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly manualBroadcastExecutor: ManualBroadcastExecutor,
    private readonly productionCustodyExecutor: ProductionCustodyExecutor,
  ) {}

  async resolve(assetNetworkId: string): Promise<WithdrawalExecutor> {
    const config = await this.prisma.withdrawalExecutionConfig.findUnique({
      where: { assetNetworkId },
    });

    const isProductionCustody = config?.executorType === WithdrawalExecutorType.PRODUCTION_CUSTODY;

    if (this.config.get("appEnvironment", { infer: true }) === "production") {
      if (!isProductionCustody) {
        throw new InternalServerErrorException(
          `No PRODUCTION_CUSTODY WithdrawalExecutionConfig is set for asset/network ${assetNetworkId} — refusing to fall back to manual broadcast in production.`,
        );
      }
      return this.productionCustodyExecutor;
    }

    return isProductionCustody ? this.productionCustodyExecutor : this.manualBroadcastExecutor;
  }
}
