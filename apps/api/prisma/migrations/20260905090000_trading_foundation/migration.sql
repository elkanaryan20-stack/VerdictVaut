-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MarketStatus" ADD VALUE 'RESOLVING';
ALTER TYPE "MarketStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'EXPIRED';

-- DropForeignKey
ALTER TABLE "fills" DROP CONSTRAINT "fills_makerOrderId_fkey";

-- DropForeignKey
ALTER TABLE "fills" DROP CONSTRAINT "fills_takerOrderId_fkey";

-- DropIndex
DROP INDEX "market_outcomes_marketId_label_key";

-- AlterTable
ALTER TABLE "fills" DROP COLUMN "createdAt",
DROP COLUMN "makerOrderId",
DROP COLUMN "takerOrderId",
ADD COLUMN     "buyOrderId" TEXT NOT NULL,
ADD COLUMN     "buyerUserId" TEXT NOT NULL,
ADD COLUMN     "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "sellOrderId" TEXT NOT NULL,
ADD COLUMN     "sellerUserId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "market_outcomes" ADD COLUMN     "key" TEXT NOT NULL,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "markets" ADD COLUMN     "maxExposure" DECIMAL(36,18),
ADD COLUMN     "openTime" TIMESTAMP(3),
ADD COLUMN     "resolutionCriteria" TEXT,
ADD COLUMN     "resolutionTime" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "clientOrderId" TEXT NOT NULL,
ADD COLUMN     "remainingQuantity" DECIMAL(36,18) NOT NULL;

-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "reservedQuantity" DECIMAL(36,18) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "risk_limits" ADD COLUMN     "maxOrderNotional" DECIMAL(36,18),
ADD COLUMN     "maxOrderQuantity" DECIMAL(36,18);

-- CreateTable
CREATE TABLE "position_reservations" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),

    CONSTRAINT "position_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "position_reservations_idempotencyKey_key" ON "position_reservations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "position_reservations_positionId_status_idx" ON "position_reservations"("positionId", "status");

-- CreateIndex
CREATE INDEX "position_reservations_referenceType_referenceId_idx" ON "position_reservations"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "fills_idempotencyKey_key" ON "fills"("idempotencyKey");

-- CreateIndex
CREATE INDEX "fills_buyOrderId_idx" ON "fills"("buyOrderId");

-- CreateIndex
CREATE INDEX "fills_sellOrderId_idx" ON "fills"("sellOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "market_outcomes_marketId_key_key" ON "market_outcomes"("marketId", "key");

-- CreateIndex
CREATE INDEX "markets_status_idx" ON "markets"("status");

-- CreateIndex
CREATE INDEX "orders_marketId_outcomeId_side_status_price_createdAt_idx" ON "orders"("marketId", "outcomeId", "side", "status", "price", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_userId_clientOrderId_key" ON "orders"("userId", "clientOrderId");

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_buyOrderId_fkey" FOREIGN KEY ("buyOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_sellOrderId_fkey" FOREIGN KEY ("sellOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_buyerUserId_fkey" FOREIGN KEY ("buyerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_sellerUserId_fkey" FOREIGN KEY ("sellerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_reservations" ADD CONSTRAINT "position_reservations_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

