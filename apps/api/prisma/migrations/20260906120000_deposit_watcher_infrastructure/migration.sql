-- AlterEnum
-- Adds a new terminal status distinct from FAILED: a deposit the chain
-- itself invalidated (e.g. a reorg dropped it) before it was ever
-- credited. Additive only -- existing PENDING/CONFIRMED/CREDITED/FAILED
-- rows and behavior are unaffected. Not used elsewhere in this same
-- migration/transaction, which is required for ALTER TYPE ... ADD VALUE
-- to be transaction-safe on Postgres.
ALTER TYPE "DepositStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "deposits" ADD COLUMN     "destinationTag" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ledgerTransactionId" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "deposits_status_lastCheckedAt_idx" ON "deposits"("status", "lastCheckedAt");

-- CheckConstraint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_retry_count_non_negative_check" CHECK ("retryCount" >= 0);
