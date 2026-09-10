import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ComplianceProviderCategory, NetworkEnvironment } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { assertValidSecretRef } from "./secret-ref.validator";

export interface CreateComplianceProviderConfigInput {
  category: ComplianceProviderCategory;
  /** Free-text/display data only — never branched on by application code. */
  providerName: string;
  environment: NetworkEnvironment;
  credentialsSecretRef?: string;
  webhookUrl?: string;
  webhookSecretRef?: string;
  timeoutMs?: number;
  apiBaseUrl?: string;
  riskScoreMediumThreshold?: number;
  riskScoreHighThreshold?: number;
}

/**
 * Phase 14A — provider-neutral compliance configuration management.
 * Configuring (even enabling) a row here does NOT itself make
 * WithdrawalComplianceGate real — see that interface's own docblock and
 * DeferredComplianceGate. This exists so ProductionSafetyGate can verify
 * configuration completeness independently of whether the code-level
 * swap to a real gate implementation has also happened, and so an
 * eventual real implementation has somewhere provider-neutral to read
 * its own settings from.
 */
@Injectable()
export class ComplianceProviderConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async createComplianceProviderConfig(input: CreateComplianceProviderConfigInput) {
    assertValidSecretRef(input.credentialsSecretRef, "credentialsSecretRef");
    assertValidSecretRef(input.webhookSecretRef, "webhookSecretRef");
    if (input.timeoutMs != null && input.timeoutMs <= 0) {
      throw new BadRequestException("timeoutMs must be positive");
    }
    const hasMedium = input.riskScoreMediumThreshold != null;
    const hasHigh = input.riskScoreHighThreshold != null;
    if (hasMedium !== hasHigh) {
      throw new BadRequestException("riskScoreMediumThreshold and riskScoreHighThreshold must be set together, or not at all");
    }
    if (hasMedium && hasHigh && input.riskScoreMediumThreshold! >= input.riskScoreHighThreshold!) {
      throw new BadRequestException("riskScoreMediumThreshold must be strictly less than riskScoreHighThreshold");
    }
    // SSRF defense-in-depth — see CustodyProviderConfigService's identical check for the full reasoning.
    if (input.apiBaseUrl != null && !/^https:\/\//i.test(input.apiBaseUrl)) {
      throw new BadRequestException("apiBaseUrl must start with https://");
    }

    return this.prisma.complianceProviderConfig.create({
      data: { ...input, isEnabled: false },
    });
  }

  async setComplianceProviderEnabled(id: string, isEnabled: boolean) {
    const existing = await this.prisma.complianceProviderConfig.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException("Compliance provider config not found");
    }
    return this.prisma.complianceProviderConfig.update({ where: { id }, data: { isEnabled } });
  }

  async listComplianceProviderConfigs(filters: { category?: ComplianceProviderCategory; environment?: NetworkEnvironment } = {}) {
    return this.prisma.complianceProviderConfig.findMany({
      where: { category: filters.category, environment: filters.environment },
      orderBy: { createdAt: "desc" },
    });
  }
}
