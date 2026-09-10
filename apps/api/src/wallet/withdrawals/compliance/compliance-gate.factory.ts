import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ComplianceProviderCategory, NetworkEnvironment } from "@prisma/client";
import { AppConfig } from "../../../config/configuration";
import { PrismaService } from "../../../prisma/prisma.service";
import { DeferredComplianceGate } from "./deferred-compliance-gate";
import { EllipticAddressRiskGate } from "./elliptic/elliptic-address-risk.gate";
import { WithdrawalComplianceAssessment, WithdrawalComplianceContext, WithdrawalComplianceGate } from "./withdrawal-compliance-gate.interface";

/**
 * Resolves which WithdrawalComplianceGate handles a given withdrawal
 * request, mirroring WithdrawalExecutorFactory's "DB config picks the
 * implementation, production always fails closed to the safe default"
 * shape (see that class's own docblock for the full reasoning). Bound
 * directly to WITHDRAWAL_COMPLIANCE_GATE in WalletModule, so
 * WithdrawalsService needs no changes to pick this up.
 *
 * Phase 14B is explicitly staging/sandbox-only for provider
 * integrations ("Do NOT enable production custody or real-money
 * production execution" — the same principle extends to compliance
 * screening, which this platform has never represented as a completed,
 * audited real-money control). Production therefore ALWAYS resolves to
 * DeferredComplianceGate, regardless of what is configured in
 * ComplianceProviderConfig — a real provider is only ever selected in
 * sandbox, below.
 */
@Injectable()
export class ComplianceGateFactory implements WithdrawalComplianceGate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly deferredGate: DeferredComplianceGate,
    private readonly ellipticGate: EllipticAddressRiskGate,
  ) {}

  async assess(context: WithdrawalComplianceContext): Promise<WithdrawalComplianceAssessment> {
    if (this.config.get("appEnvironment", { infer: true }) === "production") {
      return this.deferredGate.assess(context);
    }

    const ellipticConfigured = await this.prisma.complianceProviderConfig.findFirst({
      where: { category: ComplianceProviderCategory.SANCTIONS_KYT, environment: NetworkEnvironment.SANDBOX, providerName: { equals: "Elliptic", mode: "insensitive" }, isEnabled: true },
      select: { id: true },
    });
    if (!ellipticConfigured) {
      return this.deferredGate.assess(context);
    }

    // EllipticAddressRiskGate itself honestly reports NOT_PERFORMED/
    // DEFERRED for any network family it has no verified request shape
    // for — no separate check needed here.
    return this.ellipticGate.assess(context);
  }
}
