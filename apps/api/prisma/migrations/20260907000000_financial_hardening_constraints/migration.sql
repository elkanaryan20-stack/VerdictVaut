-- Phase 8 financial-hardening pass: DB-level backstop behind
-- DepositsService.creditDeposit(). A deposit's `ledgerTransactionId` and
-- `creditedAt` are always set together, exactly once, exactly when
-- status transitions to CREDITED (see creditDeposit()) — never before,
-- never cleared afterward (rejectIfNotCredited() explicitly excludes
-- CREDITED from what it can touch). This mirrors the same pattern
-- already enforced for PositionSettlement
-- (position_settlements_ledger_ref_consistency_check, see
-- 20260906000100_market_resolution_settlement_check_constraints) and
-- gives "a deposit cannot credit twice" a structural guarantee that does
-- not depend solely on application-level control flow or the
-- ledger_transactions.idempotencyKey unique constraint alone.
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_credited_consistency_check" CHECK (
  (status = 'CREDITED' AND "ledgerTransactionId" IS NOT NULL AND "creditedAt" IS NOT NULL) OR
  (status != 'CREDITED' AND "ledgerTransactionId" IS NULL AND "creditedAt" IS NULL)
);
