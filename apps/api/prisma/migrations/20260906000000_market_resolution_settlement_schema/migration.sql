-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'COMPLETED');

-- AlterEnum
ALTER TYPE "HouseAccountKey" ADD VALUE 'SETTLEMENT_POOL';

-- DropIndex
DROP INDEX "settlements_marketId_idx";

-- AlterTable
ALTER TABLE "positions" ADD COLUMN     "settledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "settlements" DROP COLUMN "status",
ADD COLUMN     "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "market_resolutions" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "winningOutcomeId" TEXT NOT NULL,
    "resolverId" TEXT NOT NULL,
    "notes" TEXT,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "market_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "position_settlements" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "outcomeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "quantity" DECIMAL(36,18) NOT NULL,
    "payoutPerShare" DECIMAL(18,6) NOT NULL,
    "payoutAmount" DECIMAL(36,18) NOT NULL,
    "ledgerTransactionId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "position_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "market_resolutions_marketId_key" ON "market_resolutions"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "position_settlements_positionId_key" ON "position_settlements"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "position_settlements_idempotencyKey_key" ON "position_settlements"("idempotencyKey");

-- CreateIndex
CREATE INDEX "position_settlements_marketId_idx" ON "position_settlements"("marketId");

-- CreateIndex
CREATE INDEX "position_settlements_userId_idx" ON "position_settlements"("userId");

-- CreateIndex
CREATE INDEX "positions_marketId_settledAt_idx" ON "positions"("marketId", "settledAt");

-- CreateIndex
CREATE UNIQUE INDEX "settlements_marketId_outcomeId_key" ON "settlements"("marketId", "outcomeId");

-- AddForeignKey
ALTER TABLE "market_resolutions" ADD CONSTRAINT "market_resolutions_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_resolutions" ADD CONSTRAINT "market_resolutions_winningOutcomeId_fkey" FOREIGN KEY ("winningOutcomeId") REFERENCES "market_outcomes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_resolutions" ADD CONSTRAINT "market_resolutions_resolverId_fkey" FOREIGN KEY ("resolverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_outcomeId_fkey" FOREIGN KEY ("outcomeId") REFERENCES "market_outcomes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
