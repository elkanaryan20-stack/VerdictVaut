import { Inject, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ComplianceProviderCategory, NetworkEnvironment, WithdrawalExecutorType } from "@prisma/client";
import { AppConfig } from "../config/configuration";
import { PrismaService } from "../prisma/prisma.service";
import { DeferredComplianceGate } from "./withdrawals/compliance/deferred-compliance-gate";
import { WITHDRAWAL_COMPLIANCE_GATE, WithdrawalComplianceGate } from "./withdrawals/compliance/withdrawal-compliance-gate.interface";

/**
 * Belt-and-suspenders alongside env.validation.ts's boot-time refusal
 * of APP_ENVIRONMENT=production (currently absolute, blocking 100% of
 * production boots for the custody reason alone) — the same reasoning
 * WithdrawalExecutorFactory already applies to custody. This checks
 * the ACTUAL bound compliance gate implementation, and the ACTUAL
 * provider configuration rows, at real application bootstrap (after
 * Nest's DI container has resolved everything), not just source text or
 * a single boolean flag — so it keeps telling the truth even if
 * custody's own top-level gate is ever relaxed independently and this
 * is the only thing left standing between production and an
 * unscreened/unconfigured withdrawal path.
 *
 * Every check below is currently unreachable in practice (the
 * DeferredComplianceGate check alone already blocks 100% of production
 * boots), exactly like WithdrawalExecutorFactory's own custody checks
 * were when they were added — this establishes the CONTRACT a real
 * integration must satisfy, not a claim that one exists.
 */
@Injectable()
export class ProductionSafetyGate implements OnApplicationBootstrap {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    @Inject(WITHDRAWAL_COMPLIANCE_GATE) private readonly complianceGate: WithdrawalComplianceGate,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get("appEnvironment", { infer: true }) !== "production") return;

    // Deliberately narrow: this checks WHICH CLASS is bound, not whether
    // that class "looks right" — a real compliance provider replacing
    // DeferredComplianceGate is exactly what turns this specific check off.
    if (this.complianceGate instanceof DeferredComplianceGate) {
      throw new Error(
        "APP_ENVIRONMENT=production refuses to finish starting: WITHDRAWAL_COMPLIANCE_GATE is still bound to " +
          "DeferredComplianceGate, a placeholder that defers every KYC/AML/sanctions decision to a human with no " +
          "automated screening. Bind a real WithdrawalComplianceGate implementation before running in production.",
      );
    }

    // Even a REAL compliance gate implementation needs real, enabled
    // provider configuration behind it in production — a code-level
    // swap alone doesn't prove the configuration is actually complete.
    const [kycConfigs, kytConfigs] = await Promise.all([
      this.prisma.complianceProviderConfig.count({
        where: { category: ComplianceProviderCategory.KYC, environment: NetworkEnvironment.PRODUCTION, isEnabled: true },
      }),
      this.prisma.complianceProviderConfig.count({
        where: { category: ComplianceProviderCategory.SANCTIONS_KYT, environment: NetworkEnvironment.PRODUCTION, isEnabled: true },
      }),
    ]);
    if (kycConfigs === 0) {
      throw new Error(
        "APP_ENVIRONMENT=production refuses to finish starting: no enabled KYC ComplianceProviderConfig row exists for PRODUCTION.",
      );
    }
    if (kytConfigs === 0) {
      throw new Error(
        "APP_ENVIRONMENT=production refuses to finish starting: no enabled SANCTIONS_KYT ComplianceProviderConfig row exists for PRODUCTION.",
      );
    }

    // Custody: every PRODUCTION_CUSTODY WithdrawalExecutionConfig must
    // link to an enabled, PRODUCTION-environment custody provider config
    // — withdrawal_execution_configs_custody_requires_provider_check
    // (DB level) only guarantees the FK is SET, not that it's enabled or
    // environment-consistent.
    const custodyConfigs = await this.prisma.withdrawalExecutionConfig.findMany({
      where: { executorType: WithdrawalExecutorType.PRODUCTION_CUSTODY },
      include: { custodyProviderConfig: true },
    });
    const badCustodyConfigs = custodyConfigs.filter(
      (c) => !c.custodyProviderConfig || !c.custodyProviderConfig.isEnabled || c.custodyProviderConfig.environment !== NetworkEnvironment.PRODUCTION,
    );
    if (badCustodyConfigs.length > 0) {
      throw new Error(
        `APP_ENVIRONMENT=production refuses to finish starting: ${badCustodyConfigs.length} WithdrawalExecutionConfig row(s) select ` +
          `PRODUCTION_CUSTODY but link to a missing, disabled, or non-production custody provider config ` +
          `(asset/network id(s): ${badCustodyConfigs.map((c) => c.assetNetworkId).join(", ")}).`,
      );
    }
  }
}
