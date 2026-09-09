-- Phase 12A: real settlement collateralization via complete-set minting.
-- Additive only — no existing column dropped/renamed/narrowed. No real
-- production trading/settlement data exists yet (APP_ENVIRONMENT=production
-- still cannot boot — see env.validation.ts), so no backfill is required
-- for any existing row. The two new enum values this migration relies on
-- ('MARKET' on LedgerAccountOwnerType, 'MINT' on LedgerTransactionType)
-- were added by the preceding migration,
-- 20260910000000_settlement_collateralization_enums, in their own
-- transaction — see that file for why.

-- AlterTable: LedgerAccount gains an optional marketId, populated iff
-- ownerType = 'MARKET' (enforced below by widening the existing
-- ledger_accounts_owner_ref_check rather than adding a parallel one).
ALTER TABLE "ledger_accounts" ADD COLUMN "marketId" TEXT;
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_marketId_fkey"
  FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "ledger_accounts_marketId_assetId_key" ON "ledger_accounts"("marketId", "assetId");

-- CheckConstraint: widen the existing owner/reference-consistency check
-- (see 20260904120100_financial_check_constraints) to the new MARKET
-- owner type — a MARKET-owned row must carry marketId and nothing else,
-- exactly the same discipline already applied to USER/HOUSE.
ALTER TABLE "ledger_accounts" DROP CONSTRAINT "ledger_accounts_owner_ref_check";
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_ref_check" CHECK (
  ("ownerType" = 'USER' AND "userId" IS NOT NULL AND "houseAccountKey" IS NULL AND "marketId" IS NULL) OR
  ("ownerType" = 'HOUSE' AND "houseAccountKey" IS NOT NULL AND "userId" IS NULL AND "marketId" IS NULL) OR
  ("ownerType" = 'MARKET' AND "marketId" IS NOT NULL AND "userId" IS NULL AND "houseAccountKey" IS NULL)
);
-- Note: ledger_accounts_user_balance_check (`ownerType = 'HOUSE' OR
-- (cachedBalance >= 0 AND cachedBalance >= reservedBalance)`) already
-- treats every non-HOUSE owner uniformly, so a MARKET-owned account is
-- automatically held to the same non-negative-balance discipline as a
-- USER account with NO change to that constraint.

-- CreateTable: the ONLY mechanism that ever increases the total float of
-- an outcome's shares — see the model's own docblock in schema.prisma
-- for the full economic reasoning.
CREATE TABLE "complete_set_mints" (
  "id" TEXT NOT NULL,
  "marketId" TEXT NOT NULL,
  "outcomeAId" TEXT NOT NULL,
  "outcomeBId" TEXT NOT NULL,
  "buyOrderAId" TEXT NOT NULL,
  "buyOrderBId" TEXT NOT NULL,
  "buyerAUserId" TEXT NOT NULL,
  "buyerBUserId" TEXT NOT NULL,
  "priceA" DECIMAL(18,6) NOT NULL,
  "priceB" DECIMAL(18,6) NOT NULL,
  "quantity" DECIMAL(36,18) NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "mintedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "complete_set_mints_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "complete_set_mints_idempotencyKey_key" ON "complete_set_mints"("idempotencyKey");
CREATE INDEX "complete_set_mints_marketId_idx" ON "complete_set_mints"("marketId");
CREATE INDEX "complete_set_mints_buyOrderAId_idx" ON "complete_set_mints"("buyOrderAId");
CREATE INDEX "complete_set_mints_buyOrderBId_idx" ON "complete_set_mints"("buyOrderBId");

ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_outcomeAId_fkey" FOREIGN KEY ("outcomeAId") REFERENCES "market_outcomes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_outcomeBId_fkey" FOREIGN KEY ("outcomeBId") REFERENCES "market_outcomes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_buyOrderAId_fkey" FOREIGN KEY ("buyOrderAId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_buyOrderBId_fkey" FOREIGN KEY ("buyOrderBId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_buyerAUserId_fkey" FOREIGN KEY ("buyerAUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_buyerBUserId_fkey" FOREIGN KEY ("buyerBUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint: the entire reason settlement stays fully
-- collateralized — a complete set always costs exactly 1 unit of
-- settlement currency. Guaranteed at match time by
-- CompleteSetMintEngine (the resting/maker side's price is honored
-- exactly, the incoming/taker side pays exactly the complement).
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_price_sum_check" CHECK ("priceA" + "priceB" = 1);
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_prices_positive_check" CHECK ("priceA" > 0 AND "priceB" > 0);
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_quantity_positive_check" CHECK ("quantity" > 0);
-- Structural sanity: a complete set requires two DIFFERENT outcomes and
-- two DIFFERENT orders — never a single order minting against itself.
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_distinct_outcomes_check" CHECK ("outcomeAId" <> "outcomeBId");
ALTER TABLE "complete_set_mints" ADD CONSTRAINT "complete_set_mints_distinct_orders_check" CHECK ("buyOrderAId" <> "buyOrderBId");
