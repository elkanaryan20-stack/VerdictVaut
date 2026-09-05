-- DropIndex
DROP INDEX "orders_marketId_outcomeId_side_status_price_createdAt_idx";

-- AlterTable
ALTER TABLE "fills" ADD COLUMN     "makerOrderId" TEXT NOT NULL,
ADD COLUMN     "takerOrderId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "fund_reservations" ADD COLUMN     "consumedAmount" DECIMAL(36,18) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "sequence" BIGSERIAL NOT NULL;

-- AlterTable
ALTER TABLE "position_reservations" ADD COLUMN     "consumedAmount" DECIMAL(36,18) NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "fills_makerOrderId_idx" ON "fills"("makerOrderId");

-- CreateIndex
CREATE INDEX "fills_takerOrderId_idx" ON "fills"("takerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_sequence_key" ON "orders"("sequence");

-- CreateIndex
CREATE INDEX "orders_marketId_outcomeId_side_status_price_sequence_idx" ON "orders"("marketId", "outcomeId", "side", "status", "price", "sequence");

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_makerOrderId_fkey" FOREIGN KEY ("makerOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fills" ADD CONSTRAINT "fills_takerOrderId_fkey" FOREIGN KEY ("takerOrderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
