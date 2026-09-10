-- Phase 14B: provider-integration readiness. Additive only — no
-- existing column dropped/renamed/narrowed.

-- AlterTable: withdrawal_execution_configs gains a per-asset-network
-- provider-specific asset identifier, left NULL (unsupported/fail-
-- closed) until a human confirms the real value against the provider's
-- own account/API — never inferred from assetSymbol.
ALTER TABLE "withdrawal_execution_configs" ADD COLUMN "providerAssetId" TEXT;

-- AlterTable: both provider config tables gain a non-secret REST base
-- URL, admin-configurable rather than hardcoded.
ALTER TABLE "custody_provider_configs" ADD COLUMN "apiBaseUrl" TEXT;
ALTER TABLE "compliance_provider_configs" ADD COLUMN "apiBaseUrl" TEXT;

-- CreateTable: durable, idempotent inbound-webhook-event ledger. See the
-- model's own docblock in schema.prisma.
CREATE TABLE "provider_webhook_events" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "externalEventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "resourceType" TEXT,
  "resourceId" TEXT,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMP(3),
  "processingNote" TEXT,
  "processingError" TEXT,

  CONSTRAINT "provider_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_webhook_events_provider_externalEventId_key" ON "provider_webhook_events"("provider", "externalEventId");
CREATE INDEX "provider_webhook_events_resourceType_resourceId_idx" ON "provider_webhook_events"("resourceType", "resourceId");
