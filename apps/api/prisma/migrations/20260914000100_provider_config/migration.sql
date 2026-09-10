-- Phase 14A: provider-neutral custody/compliance configuration model,
-- plus two fail-closed CHECK constraints this phase's audit found
-- missing at the database level (application-level checks already
-- existed for both but could be bypassed by a direct write, e.g. a
-- seed script). Additive only — no existing column dropped/renamed.

-- CreateEnum
CREATE TYPE "ComplianceProviderCategory" AS ENUM ('KYC', 'SANCTIONS_KYT');

-- CreateTable: provider-LEVEL custody configuration — see the model's
-- own docblock in schema.prisma. providerName is descriptive data only,
-- never branched on by application code.
CREATE TABLE "custody_provider_configs" (
  "id" TEXT NOT NULL,
  "providerName" TEXT NOT NULL,
  "environment" "NetworkEnvironment" NOT NULL,
  "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  "credentialsSecretRef" TEXT,
  "webhookUrl" TEXT,
  "webhookSecretRef" TEXT,
  "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
  "idempotencyHeaderName" TEXT,
  "vaultOrAccountRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "custody_provider_configs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "custody_provider_configs_environment_isEnabled_idx" ON "custody_provider_configs"("environment", "isEnabled");

-- CheckConstraint: a secret REFERENCE must look like one — "scheme:path"
-- (e.g. "env:FIREBLOCKS_API_KEY", "secretsmanager:prod/fireblocks/key")
-- — never a bare value, which is what pasting an actual secret in by
-- mistake would look like. This does not prove the value is safe (a
-- determined admin could still pick a scheme-shaped string and put a
-- secret after the colon), but it categorically rejects the common
-- mistake of pasting a raw API key/token with no scheme prefix at all.
ALTER TABLE "custody_provider_configs" ADD CONSTRAINT "custody_provider_configs_credentials_ref_scheme_check"
  CHECK ("credentialsSecretRef" IS NULL OR "credentialsSecretRef" ~ '^(env|secretsmanager|vault|doppler|ssm):\S+$');
ALTER TABLE "custody_provider_configs" ADD CONSTRAINT "custody_provider_configs_webhook_secret_ref_scheme_check"
  CHECK ("webhookSecretRef" IS NULL OR "webhookSecretRef" ~ '^(env|secretsmanager|vault|doppler|ssm):\S+$');
ALTER TABLE "custody_provider_configs" ADD CONSTRAINT "custody_provider_configs_timeout_positive_check"
  CHECK ("timeoutMs" > 0);

-- CreateTable: provider-neutral compliance configuration — see the
-- model's own docblock. A row here existing/being enabled does NOT
-- itself make WithdrawalComplianceGate real; see that interface's own
-- docblock for why this is deliberately a separate signal.
CREATE TABLE "compliance_provider_configs" (
  "id" TEXT NOT NULL,
  "category" "ComplianceProviderCategory" NOT NULL,
  "providerName" TEXT NOT NULL,
  "environment" "NetworkEnvironment" NOT NULL,
  "isEnabled" BOOLEAN NOT NULL DEFAULT false,
  "credentialsSecretRef" TEXT,
  "webhookUrl" TEXT,
  "webhookSecretRef" TEXT,
  "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "compliance_provider_configs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "compliance_provider_configs_category_environment_isEnabled_idx" ON "compliance_provider_configs"("category", "environment", "isEnabled");

ALTER TABLE "compliance_provider_configs" ADD CONSTRAINT "compliance_provider_configs_credentials_ref_scheme_check"
  CHECK ("credentialsSecretRef" IS NULL OR "credentialsSecretRef" ~ '^(env|secretsmanager|vault|doppler|ssm):\S+$');
ALTER TABLE "compliance_provider_configs" ADD CONSTRAINT "compliance_provider_configs_webhook_secret_ref_scheme_check"
  CHECK ("webhookSecretRef" IS NULL OR "webhookSecretRef" ~ '^(env|secretsmanager|vault|doppler|ssm):\S+$');
ALTER TABLE "compliance_provider_configs" ADD CONSTRAINT "compliance_provider_configs_timeout_positive_check"
  CHECK ("timeoutMs" > 0);

-- AlterTable: withdrawal_execution_configs links to the shared
-- provider-level config, required whenever executorType selects
-- PRODUCTION_CUSTODY (belt-and-suspenders alongside
-- WithdrawalExecutorFactory's own runtime check — this holds even
-- against a direct write that bypasses the factory).
ALTER TABLE "withdrawal_execution_configs" ADD COLUMN "custodyProviderConfigId" TEXT;
ALTER TABLE "withdrawal_execution_configs" ADD CONSTRAINT "withdrawal_execution_configs_custodyProviderConfigId_fkey"
  FOREIGN KEY ("custodyProviderConfigId") REFERENCES "custody_provider_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_execution_configs" ADD CONSTRAINT "withdrawal_execution_configs_custody_requires_provider_check"
  CHECK ("executorType" != 'PRODUCTION_CUSTODY' OR "custodyProviderConfigId" IS NOT NULL);

-- CheckConstraint: an active non-native AssetNetwork must have a real
-- contractAddress — the DB-level backstop for AssetsNetworksService's
-- existing application-level check (Phase 11), which only guards its
-- own code path. Found missing by the Phase 14A audit: prisma/seed.ts's
-- USDT/ethereum-sepolia row (no real Sepolia USDT contract exists) was
-- upserted directly, bypassing the service, and defaulted to isActive:
-- true — this constraint would have caught that; the accompanying
-- seed.ts fix sets it isActive: false instead of inventing an address.
ALTER TABLE "asset_networks" ADD CONSTRAINT "asset_networks_active_token_requires_contract_check"
  CHECK (NOT "isActive" OR "isNative" OR "contractAddress" IS NOT NULL);
