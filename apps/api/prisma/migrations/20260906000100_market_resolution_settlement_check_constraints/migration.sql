-- Market-resolution/settlement financial invariants, as a DB-level
-- backstop behind the application-level checks in ResolutionService/
-- SettlementService. SETTLEMENT_POOL needs no new exemption here: the
-- existing "ledger_accounts_user_balance_check" (see
-- 20260904120100_financial_check_constraints) already exempts every
-- HOUSE account uniformly, and SETTLEMENT_POOL is expected to run
-- persistently negative for the same documented reason as EXTERNAL_CHAIN
-- (see the HouseAccountKey enum comment in schema.prisma).

-- settlements: a payout rate can never be negative.
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_payout_per_share_non_negative_check" CHECK (
  "payoutPerShare" >= 0
);

-- position_settlements: quantity/rate/payout are all non-negative — this
-- system has no naked shorts and no negative payouts.
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_quantity_non_negative_check" CHECK (
  "quantity" >= 0
);

ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_payout_per_share_non_negative_check" CHECK (
  "payoutPerShare" >= 0
);

ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_payout_amount_non_negative_check" CHECK (
  "payoutAmount" >= 0
);

-- The payout amount is never a number SettlementService merely asserts —
-- it is arithmetically derivable from the other two snapshotted columns
-- on the SAME row, and the database enforces that derivation directly.
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_payout_amount_consistency_check" CHECK (
  "payoutAmount" = "quantity" * "payoutPerShare"
);

-- A ledger transaction reference exists if and only if real cash moved
-- (payoutAmount > 0) — a losing/zero-quantity position posts no ledger
-- entry at all, so it must not carry a dangling reference to one.
ALTER TABLE "position_settlements" ADD CONSTRAINT "position_settlements_ledger_ref_consistency_check" CHECK (
  ("payoutAmount" = 0 AND "ledgerTransactionId" IS NULL) OR
  ("payoutAmount" > 0 AND "ledgerTransactionId" IS NOT NULL)
);

-- market_resolutions: settlement (payout completion) can never be
-- recorded as happening before the resolution decision it settles.
ALTER TABLE "market_resolutions" ADD CONSTRAINT "market_resolutions_settled_after_resolved_check" CHECK (
  "settledAt" IS NULL OR "settledAt" >= "resolvedAt"
);
