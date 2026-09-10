import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { NetworkEnvironment, WithdrawalExecutorType } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { assertValidSecretRef } from "./secret-ref.validator";

export interface CreateCustodyProviderConfigInput {
  /** Free-text/display data only — NEVER branched on by application code (see the model's own docblock). */
  providerName: string;
  environment: NetworkEnvironment;
  credentialsSecretRef?: string;
  webhookUrl?: string;
  webhookSecretRef?: string;
  timeoutMs?: number;
  idempotencyHeaderName?: string;
  vaultOrAccountRef?: string;
  apiBaseUrl?: string;
}

/**
 * Phase 14A — provider-neutral custody configuration management.
 * SUPER_ADMIN-only (enforced at the controller); this service's own job
 * is validating that what gets stored can never look like a live
 * integration when it isn't, and can never accidentally hold a raw
 * secret instead of a reference to one.
 */
@Injectable()
export class CustodyProviderConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async createCustodyProviderConfig(input: CreateCustodyProviderConfigInput) {
    assertValidSecretRef(input.credentialsSecretRef, "credentialsSecretRef");
    assertValidSecretRef(input.webhookSecretRef, "webhookSecretRef");
    if (input.timeoutMs != null && input.timeoutMs <= 0) {
      throw new BadRequestException("timeoutMs must be positive");
    }
    // SSRF defense-in-depth: this value is only ever settable by
    // SUPER_ADMIN (the platform's highest-trust actor), so this is not
    // a broken-access-control concern — but requiring https:// still
    // rules out an accidental/typo'd http:// or non-HTTP scheme (e.g.
    // file://) ending up in a real outbound fetch() call.
    if (input.apiBaseUrl != null && !/^https:\/\//i.test(input.apiBaseUrl)) {
      throw new BadRequestException("apiBaseUrl must start with https://");
    }

    // Always created disabled — enabling is a deliberate, separate,
    // audited action (setEnabled below), never implicit at creation.
    return this.prisma.custodyProviderConfig.create({
      data: { ...input, isEnabled: false },
    });
  }

  async setCustodyProviderEnabled(id: string, isEnabled: boolean) {
    const existing = await this.prisma.custodyProviderConfig.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException("Custody provider config not found");
    }
    return this.prisma.custodyProviderConfig.update({ where: { id }, data: { isEnabled } });
  }

  async listCustodyProviderConfigs() {
    return this.prisma.custodyProviderConfig.findMany({ orderBy: { createdAt: "desc" } });
  }

  /**
   * Links (or clears) one asset/network's withdrawal execution routing.
   * PRODUCTION_CUSTODY requires a custodyProviderConfigId pointing at an
   * EXISTING, ENVIRONMENT-MATCHING provider config — belt-and-suspenders
   * alongside withdrawal_execution_configs_custody_requires_provider_check
   * (the DB constraint only guarantees a value is set, not that it
   * resolves to something real/consistent). The linked config does NOT
   * need to be enabled yet at this point — enabling it is a separate
   * step, and WithdrawalExecutorFactory independently refuses to
   * execute against a disabled one regardless of this check.
   */
  async setWithdrawalExecutionConfig(input: {
    assetNetworkId: string;
    environment: NetworkEnvironment;
    executorType: WithdrawalExecutorType;
    custodyProviderConfigId?: string;
    providerRef?: string;
    providerAssetId?: string;
  }) {
    const assetNetwork = await this.prisma.assetNetwork.findUnique({ where: { id: input.assetNetworkId } });
    if (!assetNetwork) {
      throw new NotFoundException("Asset/network pair not found");
    }
    // Section 5: custody/withdrawal support is a separate signal from
    // blockchain-observation support (AssetNetwork.isActive) — but an
    // asset/network that isn't even active for deposits has no business
    // being configured for withdrawal execution either.
    if (!assetNetwork.isActive) {
      throw new BadRequestException("Cannot configure withdrawal execution for an inactive asset/network");
    }

    if (input.executorType === WithdrawalExecutorType.PRODUCTION_CUSTODY) {
      if (!input.custodyProviderConfigId) {
        throw new BadRequestException("executorType PRODUCTION_CUSTODY requires a custodyProviderConfigId");
      }
      const providerConfig = await this.prisma.custodyProviderConfig.findUnique({ where: { id: input.custodyProviderConfigId } });
      if (!providerConfig) {
        throw new NotFoundException("Custody provider config not found");
      }
      if (providerConfig.environment !== input.environment) {
        throw new BadRequestException(
          `Environment mismatch: this WithdrawalExecutionConfig is ${input.environment} but the linked custody provider config is ${providerConfig.environment}.`,
        );
      }
    }

    return this.prisma.withdrawalExecutionConfig.upsert({
      where: { assetNetworkId: input.assetNetworkId },
      create: {
        assetNetworkId: input.assetNetworkId,
        environment: input.environment,
        executorType: input.executorType,
        custodyProviderConfigId: input.executorType === WithdrawalExecutorType.PRODUCTION_CUSTODY ? input.custodyProviderConfigId : null,
        providerRef: input.providerRef,
        providerAssetId: input.executorType === WithdrawalExecutorType.PRODUCTION_CUSTODY ? input.providerAssetId : null,
      },
      update: {
        environment: input.environment,
        executorType: input.executorType,
        custodyProviderConfigId: input.executorType === WithdrawalExecutorType.PRODUCTION_CUSTODY ? input.custodyProviderConfigId : null,
        providerRef: input.providerRef,
        providerAssetId: input.executorType === WithdrawalExecutorType.PRODUCTION_CUSTODY ? input.providerAssetId : null,
      },
    });
  }

  async listWithdrawalExecutionConfigs() {
    return this.prisma.withdrawalExecutionConfig.findMany({
      include: { assetNetwork: { include: { asset: true, network: true } }, custodyProviderConfig: true },
      orderBy: { updatedAt: "desc" },
    });
  }
}
