-- DropIndex
DROP INDEX "deposits_assetNetworkId_txHash_key";

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "deposits" ADD COLUMN     "eventIndex" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "audit_logs_idempotencyKey_idx" ON "audit_logs"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_assetNetworkId_txHash_eventIndex_key" ON "deposits"("assetNetworkId", "txHash", "eventIndex");

