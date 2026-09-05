-- Trading-foundation financial invariants, as a DB-level backstop behind
-- the application-level checks in OrdersService/PositionReservationService.

-- orders: remainingQuantity is bounded by quantity, and the two live
-- figures (filled + remaining) must always reconstruct the original size.
ALTER TABLE "orders" ADD CONSTRAINT "orders_remaining_quantity_bounds_check" CHECK (
  "remainingQuantity" >= 0 AND "remainingQuantity" <= "quantity"
);

ALTER TABLE "orders" ADD CONSTRAINT "orders_filled_plus_remaining_check" CHECK (
  "filledQuantity" + "remainingQuantity" = "quantity"
);

-- fills: an order can never execute against itself.
ALTER TABLE "fills" ADD CONSTRAINT "fills_buy_sell_distinct_check" CHECK (
  "buyOrderId" <> "sellOrderId"
);

-- positions: reservedQuantity is the share-inventory mirror of
-- ledger_accounts.reservedBalance — same bounds, same reasoning.
ALTER TABLE "positions" ADD CONSTRAINT "positions_reserved_bounds_check" CHECK (
  "reservedQuantity" >= 0 AND "reservedQuantity" <= "quantity"
);

-- position_reservations: always a positive earmark, mirroring fund_reservations.
ALTER TABLE "position_reservations" ADD CONSTRAINT "position_reservations_amount_positive_check" CHECK (
  "amount" > 0
);

-- markets: an unset cap (NULL) means unlimited; a configured one must be sane.
ALTER TABLE "markets" ADD CONSTRAINT "markets_max_exposure_non_negative_check" CHECK (
  "maxExposure" IS NULL OR "maxExposure" >= 0
);

-- risk_limits: the two new per-order extension points, same non-negative rule as the existing ones.
ALTER TABLE "risk_limits" ADD CONSTRAINT "risk_limits_order_limits_non_negative_check" CHECK (
  ("maxOrderQuantity" IS NULL OR "maxOrderQuantity" >= 0) AND
  ("maxOrderNotional" IS NULL OR "maxOrderNotional" >= 0)
);
