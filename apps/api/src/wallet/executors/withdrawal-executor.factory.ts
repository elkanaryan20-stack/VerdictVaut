import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WithdrawalExecutorType } from "@prisma/client";
import { AppConfig } from "../../config/configuration";
import { PrismaService } from "../../prisma/prisma.service";
import { requiredProviderConfigEnvironment } from "../provider-config/provider-environment.util";
import { FireblocksCustodyAdapter } from "./fireblocks/fireblocks-custody.adapter";
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
    private readonly fireblocksCustodyAdapter: FireblocksCustodyAdapter,
  ) {}

  async resolve(assetNetworkId: string): Promise<WithdrawalExecutor> {
    const config = await this.prisma.withdrawalExecutionConfig.findUnique({
      where: { assetNetworkId },
      include: { custodyProviderConfig: true },
    });

    const isProductionCustody = config?.executorType === WithdrawalExecutorType.PRODUCTION_CUSTODY;
    const appEnvironment = this.config.get("appEnvironment", { infer: true });

    if (appEnvironment === "production") {
      if (!isProductionCustody) {
        throw new InternalServerErrorException(
          `No PRODUCTION_CUSTODY WithdrawalExecutionConfig is set for asset/network ${assetNetworkId} — refusing to fall back to manual broadcast in production.`,
        );
      }
      // Belt-and-suspenders alongside the DB-level
      // withdrawal_execution_configs_custody_requires_provider_check
      // (which only guarantees a provider config is LINKED, not that
      // it's currently enabled) — a provider config disabled after the
      // fact (e.g. mid-incident) must not silently keep routing real
      // withdrawals to it.
      if (!config.custodyProviderConfig?.isEnabled) {
        throw new InternalServerErrorException(
          `WithdrawalExecutionConfig for asset/network ${assetNetworkId} is linked to a custody provider config that is not enabled — refusing to execute.`,
        );
      }
      // Security review finding A1: verified explicitly, at resolve()
      // time, rather than relying on ProductionCustodyExecutor's own
      // unconditional throw to eventually surface a SANDBOX-flagged
      // config being linked here. This is currently unreachable-by-
      // consequence (the line below always returns the still-throwing
      // placeholder regardless), but making the check explicit here —
      // not just implicit in "the placeholder always throws anyway" —
      // means this guarantee survives independently of that other fact.
      this.assertProviderConfigEnvironment(config.custodyProviderConfig, appEnvironment, assetNetworkId);
      // Production ALWAYS resolves to the still-unconditionally-throwing
      // placeholder, regardless of provider name/config — Phase 14B is
      // explicitly staging/sandbox-only ("Do NOT enable production
      // custody or real-money production execution"). A real provider
      // adapter is only ever selected in the branch below, which this
      // production check already returned from.
      return this.assertSupportsAssetNetwork(this.productionCustodyExecutor, assetNetworkId);
    }

    if (!isProductionCustody) {
      return this.assertSupportsAssetNetwork(this.manualBroadcastExecutor, assetNetworkId);
    }

    // Sandbox + PRODUCTION_CUSTODY: route to a REAL provider adapter,
    // selected by the linked CustodyProviderConfig's providerName —
    // this is the one place that name is actually branched on (Phase
    // 14A's own docblock called this out as future work once a real
    // integration existed; see FireblocksCustodyAdapter). An
    // unrecognized/misconfigured provider name fails closed — it never
    // silently falls back to manual broadcast, which would make a
    // deliberately-configured "real provider" test silently behave like
    // a no-op sandbox executor instead of surfacing the misconfiguration.
    if (!config.custodyProviderConfig?.isEnabled) {
      throw new InternalServerErrorException(
        `WithdrawalExecutionConfig for asset/network ${assetNetworkId} is linked to a custody provider config that is not enabled.`,
      );
    }
    // Security review finding A1: a non-production process must NEVER
    // resolve to a PRODUCTION-flagged CustodyProviderConfig — that
    // config may hold real production credentials. This is checked
    // independently of (and in addition to) the identical check inside
    // FireblocksCustodyAdapter itself, so bypassing this factory (e.g. a
    // future caller that constructs the adapter directly) still cannot
    // use a mismatched-environment provider config — see that class's
    // own docblock.
    this.assertProviderConfigEnvironment(config.custodyProviderConfig, appEnvironment, assetNetworkId);
    const providerName = config.custodyProviderConfig.providerName.toUpperCase();
    if (providerName === "FIREBLOCKS") {
      return this.assertSupportsAssetNetwork(this.fireblocksCustodyAdapter, assetNetworkId);
    }
    throw new InternalServerErrorException(
      `CustodyProviderConfig.providerName "${config.custodyProviderConfig.providerName}" has no corresponding adapter implementation ` +
        `— refusing to guess which one to use. Currently implemented: Fireblocks (sandbox only).`,
    );
  }

  /**
   * Security review finding A1 — the central environment-isolation
   * guard for this factory: refuses to proceed if the linked
   * CustodyProviderConfig's own `environment` flag does not match what
   * this process's appEnvironment requires (see
   * requiredProviderConfigEnvironment's own docblock for the exact
   * mapping). Never solved by relying on config-creation-time
   * conventions alone (e.g. setWithdrawalExecutionConfig's
   * environment-consistency check) — that only guarantees internal
   * consistency BETWEEN two DB rows, never that either of them matches
   * the ACTUAL running process, which is a separate fact those rows
   * cannot see.
   */
  private assertProviderConfigEnvironment(custodyProviderConfig: { environment: string; id: string }, appEnvironment: string, assetNetworkId: string): void {
    const required = requiredProviderConfigEnvironment(appEnvironment);
    if (custodyProviderConfig.environment !== required) {
      throw new InternalServerErrorException(
        `WithdrawalExecutionConfig for asset/network ${assetNetworkId} is linked to CustodyProviderConfig ${custodyProviderConfig.id}, flagged ` +
          `${custodyProviderConfig.environment}, but the running application environment ("${appEnvironment}") requires ${required} — refusing to use ` +
          "a provider configuration from a different environment.",
      );
    }
  }

  /**
   * Checked here, once, rather than leaving every call site to remember
   * — an executor implementation that declares supportsAssetNetwork()
   * (optional; most don't need to) gets it enforced automatically before
   * execute() is ever reached.
   */
  private async assertSupportsAssetNetwork(executor: WithdrawalExecutor, assetNetworkId: string): Promise<WithdrawalExecutor> {
    if (executor.supportsAssetNetwork && !(await executor.supportsAssetNetwork(assetNetworkId))) {
      throw new InternalServerErrorException(`The configured withdrawal executor does not support asset/network ${assetNetworkId}.`);
    }
    return executor;
  }
}
