-- Financial invariants enforced at the database level, as a backstop
-- behind the application-level checks in LedgerService/ReservationService.
-- House accounts (specifically EXTERNAL_CHAIN) are the one deliberate
-- exception to non-negative balances: they mirror the outside blockchain
-- world and are expected to run negative as users deposit funds.

-- ledger_accounts: valid owner/reference combination, non-negative for USER accounts
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_owner_ref_check" CHECK (
  ("ownerType" = 'USER' AND "userId" IS NOT NULL AND "houseAccountKey" IS NULL) OR
  ("ownerType" = 'HOUSE' AND "houseAccountKey" IS NOT NULL AND "userId" IS NULL)
);

ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_reserved_non_negative_check" CHECK (
  "reservedBalance" >= 0
);

ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_user_balance_check" CHECK (
  "ownerType" = 'HOUSE' OR ("cachedBalance" >= 0 AND "cachedBalance" >= "reservedBalance")
);

-- fund_reservations: always a positive earmark
ALTER TABLE "fund_reservations" ADD CONSTRAINT "fund_reservations_amount_positive_check" CHECK (
  "amount" > 0
);

-- orders: positive quantity, fill progress within bounds, valid probability price
ALTER TABLE "orders" ADD CONSTRAINT "orders_quantity_positive_check" CHECK (
  "quantity" > 0
);

ALTER TABLE "orders" ADD CONSTRAINT "orders_filled_quantity_bounds_check" CHECK (
  "filledQuantity" >= 0 AND "filledQuantity" <= "quantity"
);

ALTER TABLE "orders" ADD CONSTRAINT "orders_price_probability_check" CHECK (
  "price" IS NULL OR ("price" > 0 AND "price" < 1)
);

-- fills: positive quantity, valid probability price, non-negative fee
ALTER TABLE "fills" ADD CONSTRAINT "fills_quantity_positive_check" CHECK (
  "quantity" > 0
);

ALTER TABLE "fills" ADD CONSTRAINT "fills_price_probability_check" CHECK (
  "price" > 0 AND "price" < 1
);

ALTER TABLE "fills" ADD CONSTRAINT "fills_fee_non_negative_check" CHECK (
  "fee" >= 0
);

-- positions: no naked short positions under the current design
ALTER TABLE "positions" ADD CONSTRAINT "positions_quantity_non_negative_check" CHECK (
  "quantity" >= 0
);

-- deposits: positive amount, non-negative confirmation counters
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_amount_positive_check" CHECK (
  "amount" > 0
);

ALTER TABLE "deposits" ADD CONSTRAINT "deposits_confirmations_non_negative_check" CHECK (
  "confirmations" >= 0 AND "requiredConfirmations" >= 0
);

-- withdrawals: positive amount, non-negative fee
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_amount_positive_check" CHECK (
  "amount" > 0
);

ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_fee_non_negative_check" CHECK (
  "fee" >= 0
);

-- asset_networks: non-negative operational thresholds
ALTER TABLE "asset_networks" ADD CONSTRAINT "asset_networks_min_confirmations_non_negative_check" CHECK (
  "minConfirmations" >= 0
);

ALTER TABLE "asset_networks" ADD CONSTRAINT "asset_networks_min_amounts_non_negative_check" CHECK (
  "depositMinAmount" >= 0 AND "withdrawalMinAmount" >= 0
);

-- risk_limits: non-negative limits and tiers
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_non_negative_check" CHECK (
  ("maxPositionSize" IS NULL OR "maxPositionSize" >= 0) AND
  ("maxDailyWithdrawal" IS NULL OR "maxDailyWithdrawal" >= 0) AND
  "kycTier" >= 0
);
