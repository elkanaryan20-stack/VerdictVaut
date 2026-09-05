-- Matching-engine financial invariants, as a DB-level backstop behind the
-- application-level checks in the ExecutionCoordinator/ReservationService/
-- PositionReservationService.

-- fills: maker/taker must be exactly the buy/sell pair, in one order or the
-- other — never anything outside that pair, never both fields equal.
ALTER TABLE "fills" ADD CONSTRAINT "fills_maker_taker_check" CHECK (
  ("makerOrderId" = "buyOrderId" AND "takerOrderId" = "sellOrderId") OR
  ("makerOrderId" = "sellOrderId" AND "takerOrderId" = "buyOrderId")
);

-- fund_reservations / position_reservations: consumedAmount tracks partial
-- fills against a still-ACTIVE reservation. It can never be negative and
-- can never exceed the amount actually earmarked.
ALTER TABLE "fund_reservations" ADD CONSTRAINT "fund_reservations_consumed_bounds_check" CHECK (
  "consumedAmount" >= 0 AND "consumedAmount" <= "amount"
);

ALTER TABLE "position_reservations" ADD CONSTRAINT "position_reservations_consumed_bounds_check" CHECK (
  "consumedAmount" >= 0 AND "consumedAmount" <= "amount"
);
