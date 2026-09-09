-- Phase 12A: independent blockchain rescan-and-diff reconciliation.
-- Additive only — no existing column dropped/renamed/narrowed, and every
-- new column on the pre-existing reconciliation_runs table is nullable
-- or carries a safe default, so no backfill is required for existing
-- rows.

-- CreateEnum
CREATE TYPE "ReconciliationRunType" AS ENUM ('CURSOR_BASED_CHECKS', 'INDEPENDENT_RESCAN');
CREATE TYPE "DiscrepancyStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'FALSE_POSITIVE');

-- AlterTable: reconciliation_runs gains run-type/initiator/window
-- tracking, all optional so existing rows (implicitly
-- CURSOR_BASED_CHECKS, per the column default) remain valid as-is.
ALTER TABLE "reconciliation_runs" ADD COLUMN "runType" "ReconciliationRunType" NOT NULL DEFAULT 'CURSOR_BASED_CHECKS';
ALTER TABLE "reconciliation_runs" ADD COLUMN "initiatedByUserId" TEXT;
ALTER TABLE "reconciliation_runs" ADD COLUMN "fromPointer" TEXT;
ALTER TABLE "reconciliation_runs" ADD COLUMN "toPointer" TEXT;
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_initiatedByUserId_fkey"
  FOREIGN KEY ("initiatedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable: first-class, individually-resolvable discrepancy record —
-- see the model's own docblock in schema.prisma for the full reasoning.
CREATE TABLE "reconciliation_discrepancies" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "assetNetworkId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "chainIdentity" TEXT NOT NULL,
  "internalEntityType" TEXT,
  "internalEntityId" TEXT,
  "expectedState" JSONB NOT NULL,
  "observedState" JSONB NOT NULL,
  "status" "DiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "resolvedByUserId" TEXT,
  "notes" TEXT,
  "idempotencyKey" TEXT NOT NULL,

  CONSTRAINT "reconciliation_discrepancies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reconciliation_discrepancies_idempotencyKey_key" ON "reconciliation_discrepancies"("idempotencyKey");
CREATE INDEX "reconciliation_discrepancies_assetNetworkId_status_idx" ON "reconciliation_discrepancies"("assetNetworkId", "status");
CREATE INDEX "reconciliation_discrepancies_runId_idx" ON "reconciliation_discrepancies"("runId");

ALTER TABLE "reconciliation_discrepancies" ADD CONSTRAINT "reconciliation_discrepancies_runId_fkey" FOREIGN KEY ("runId") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reconciliation_discrepancies" ADD CONSTRAINT "reconciliation_discrepancies_assetNetworkId_fkey" FOREIGN KEY ("assetNetworkId") REFERENCES "asset_networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reconciliation_discrepancies" ADD CONSTRAINT "reconciliation_discrepancies_resolvedByUserId_fkey" FOREIGN KEY ("resolvedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint: a resolved/false-positive discrepancy must carry the
-- who/when that closed it; an OPEN/ACKNOWLEDGED one must not — never a
-- transiently-inconsistent "resolved but nobody resolved it" row.
ALTER TABLE "reconciliation_discrepancies" ADD CONSTRAINT "reconciliation_discrepancies_resolution_consistency_check" CHECK (
  (status IN ('RESOLVED', 'FALSE_POSITIVE') AND "resolvedAt" IS NOT NULL AND "resolvedByUserId" IS NOT NULL) OR
  (status IN ('OPEN', 'ACKNOWLEDGED') AND "resolvedAt" IS NULL AND "resolvedByUserId" IS NULL)
);
