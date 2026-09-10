-- Phase 13: collateral reconciliation extends the existing chain-based
-- reconciliation tables to also cover per-market collateral integrity.
-- Phase 12A's core guarantee — that a market's collateral LedgerAccount
-- balance always equals total minted shares minus paid-out settlements
-- — was never independently verified by any automated check until now
-- (see CollateralReconciliationService).
--
-- Both reconciliation_runs and reconciliation_discrepancies previously
-- assumed every row was chain/assetNetwork-scoped. A collateral check is
-- market-scoped instead, so assetNetworkId becomes nullable and a new
-- nullable marketId is added, with a CHECK constraint mirroring
-- ledger_accounts_owner_ref_check's "exactly one of X/Y" pattern to keep
-- every row unambiguously chain-scoped OR market-scoped, never both,
-- never neither.

ALTER TABLE "reconciliation_runs" ALTER COLUMN "assetNetworkId" DROP NOT NULL;
ALTER TABLE "reconciliation_runs" ADD COLUMN "marketId" TEXT;

ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_target_check"
  CHECK (("assetNetworkId" IS NOT NULL AND "marketId" IS NULL) OR ("assetNetworkId" IS NULL AND "marketId" IS NOT NULL));

ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_marketId_fkey"
  FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "reconciliation_runs_marketId_runAt_idx" ON "reconciliation_runs"("marketId", "runAt");

ALTER TABLE "reconciliation_discrepancies" ALTER COLUMN "assetNetworkId" DROP NOT NULL;
ALTER TABLE "reconciliation_discrepancies" ADD COLUMN "marketId" TEXT;

ALTER TABLE "reconciliation_discrepancies" ADD CONSTRAINT "reconciliation_discrepancies_target_check"
  CHECK (("assetNetworkId" IS NOT NULL AND "marketId" IS NULL) OR ("assetNetworkId" IS NULL AND "marketId" IS NOT NULL));

ALTER TABLE "reconciliation_discrepancies" ADD CONSTRAINT "reconciliation_discrepancies_marketId_fkey"
  FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "reconciliation_discrepancies_marketId_status_idx" ON "reconciliation_discrepancies"("marketId", "status");
