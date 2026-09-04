-- CreateEnum
CREATE TYPE "LedgerTransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRADE', 'FEE', 'SETTLEMENT', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "LedgerAccountOwnerType" AS ENUM ('USER', 'HOUSE');

-- CreateEnum
CREATE TYPE "HouseAccountKey" AS ENUM ('EXTERNAL_CHAIN', 'FEE_REVENUE');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CAPTURED');

-- DropForeignKey
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_userId_fkey";

-- DropIndex
DROP INDEX "ledger_entries_referenceType_referenceId_idx";

-- AlterTable
ALTER TABLE "ledger_accounts" ADD COLUMN     "houseAccountKey" "HouseAccountKey",
ADD COLUMN     "ownerType" "LedgerAccountOwnerType" NOT NULL DEFAULT 'USER',
ADD COLUMN     "reservedBalance" DECIMAL(36,18) NOT NULL DEFAULT 0,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ledger_entries" DROP COLUMN "referenceId",
DROP COLUMN "referenceType",
DROP COLUMN "type",
ADD COLUMN     "transactionId" TEXT NOT NULL;

-- DropEnum
DROP TYPE "LedgerEntryType";

-- CreateTable
CREATE TABLE "ledger_transactions" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "type" "LedgerTransactionType" NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fund_reservations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3),

    CONSTRAINT "fund_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_idempotencyKey_key" ON "ledger_transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ledger_transactions_referenceType_referenceId_idx" ON "ledger_transactions"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "fund_reservations_idempotencyKey_key" ON "fund_reservations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "fund_reservations_accountId_status_idx" ON "fund_reservations"("accountId", "status");

-- CreateIndex
CREATE INDEX "fund_reservations_referenceType_referenceId_idx" ON "fund_reservations"("referenceType", "referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_houseAccountKey_assetId_key" ON "ledger_accounts"("houseAccountKey", "assetId");

-- CreateIndex
CREATE INDEX "ledger_entries_transactionId_idx" ON "ledger_entries"("transactionId");

-- AddForeignKey
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_transactions" ADD CONSTRAINT "ledger_transactions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fund_reservations" ADD CONSTRAINT "fund_reservations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

