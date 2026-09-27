import { AssetClass, AuditActorType, DepositStatus, DiscrepancyStatus, MarketStatus, OrderSide, OrderStatus, OrderType, WithdrawalComplianceDecision, WithdrawalStatus } from "@prisma/client";
import {
  AUDIT_ACTOR_TYPES,
  AssetClassSchema,
  DEPOSIT_STATUSES,
  DISCREPANCY_STATUSES,
  MARKET_STATUSES,
  ORDER_STATUSES,
  OrderSideSchema,
  OrderTypeSchema,
  WITHDRAWAL_STATUSES,
  WithdrawalComplianceDecisionSchema,
} from "@verdictvaut/shared-types";

/**
 * Phase 36 — the web client validates every API response against the
 * zod enums in @verdictvaut/shared-types, so a value the backend can
 * return but the shared enum lacks makes the WHOLE response fail
 * validation (Phase 36 found exactly this: WithdrawalStatus had drifted
 * without EXECUTION_AMBIGUOUS since Phase 14A, breaking every withdrawal
 * list containing one). These assertions tie each shared enum to the
 * Prisma enum it mirrors, so the next drift fails CI instead of production.
 */
const sorted = (values: readonly string[]) => [...values].sort();

describe("shared-types ↔ Prisma enum contract", () => {
  it.each([
    ["WithdrawalStatus", WITHDRAWAL_STATUSES, WithdrawalStatus],
    ["DepositStatus", DEPOSIT_STATUSES, DepositStatus],
    ["OrderStatus", ORDER_STATUSES, OrderStatus],
    ["MarketStatus", MARKET_STATUSES, MarketStatus],
    ["OrderSide", OrderSideSchema.options, OrderSide],
    ["OrderType", OrderTypeSchema.options, OrderType],
    ["AssetClass", AssetClassSchema.options, AssetClass],
    ["WithdrawalComplianceDecision", WithdrawalComplianceDecisionSchema.options, WithdrawalComplianceDecision],
    ["AuditActorType", AUDIT_ACTOR_TYPES, AuditActorType],
    ["DiscrepancyStatus", DISCREPANCY_STATUSES, DiscrepancyStatus],
  ] as const)("%s: every value the backend can return is accepted by the shared schema, and vice versa", (_name, shared, prismaEnum) => {
    expect(sorted(shared)).toEqual(sorted(Object.values(prismaEnum)));
  });
});
