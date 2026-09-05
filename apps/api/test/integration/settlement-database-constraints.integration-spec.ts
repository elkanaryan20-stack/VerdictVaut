import { createTestAdmin, createTestMarket, createTestUser, marketsService, openMarketForTest, prisma } from "./helpers";

async function setupClosedMarketWithPosition() {
  const admin = await createTestAdmin();
  const trader = await createTestUser();
  const { market, yes } = await createTestMarket(admin.id);
  await openMarketForTest(market.id, admin.id);
  await marketsService.close(market.id, admin.id);
  const position = await prisma.position.create({
    data: { userId: trader.id, marketId: market.id, outcomeId: yes.id, quantity: 10, reservedQuantity: 0 },
  });
  return { admin, trader, market, yes, position };
}

describe("Market-resolution/settlement database invariants (real Postgres)", () => {
  it("rejects a negative Settlement.payoutPerShare", async () => {
    const admin = await createTestAdmin();
    const { market, yes } = await createTestMarket(admin.id);

    await expect(
      prisma.settlement.create({ data: { marketId: market.id, outcomeId: yes.id, payoutPerShare: -1 } }),
    ).rejects.toThrow(/settlements_payout_per_share_non_negative_check/);
  });

  it("enforces unique (marketId, outcomeId) on Settlement", async () => {
    const admin = await createTestAdmin();
    const { market, yes } = await createTestMarket(admin.id);
    await prisma.settlement.create({ data: { marketId: market.id, outcomeId: yes.id, payoutPerShare: 1 } });

    await expect(
      prisma.settlement.create({ data: { marketId: market.id, outcomeId: yes.id, payoutPerShare: 0 } }),
    ).rejects.toThrow(/Unique constraint failed.*marketId.*outcomeId/s);
  });

  it("rejects a negative PositionSettlement.quantity", async () => {
    const { market, yes, position } = await setupClosedMarketWithPosition();

    await expect(
      prisma.positionSettlement.create({
        data: {
          positionId: position.id,
          marketId: market.id,
          outcomeId: yes.id,
          userId: position.userId,
          quantity: -1,
          // payoutPerShare 0 keeps payoutAmount at exactly 0 (-1 * 0),
          // satisfying the non-negative and consistency checks and the
          // null-ledgerTransactionId branch of the ledger-ref check, so
          // this row isolates the quantity check specifically.
          payoutPerShare: 0,
          payoutAmount: 0,
          idempotencyKey: `bad-quantity-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/position_settlements_quantity_non_negative_check/);
  });

  it("rejects payoutAmount that is not quantity * payoutPerShare", async () => {
    const { market, yes, position } = await setupClosedMarketWithPosition();

    await expect(
      prisma.positionSettlement.create({
        data: {
          positionId: position.id,
          marketId: market.id,
          outcomeId: yes.id,
          userId: position.userId,
          quantity: 10,
          payoutPerShare: 1,
          payoutAmount: 5, // should be 10
          ledgerTransactionId: "irrelevant-for-this-check",
          idempotencyKey: `bad-payout-math-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/position_settlements_payout_amount_consistency_check/);
  });

  it("rejects a nonzero payoutAmount with no ledgerTransactionId", async () => {
    const { market, yes, position } = await setupClosedMarketWithPosition();

    await expect(
      prisma.positionSettlement.create({
        data: {
          positionId: position.id,
          marketId: market.id,
          outcomeId: yes.id,
          userId: position.userId,
          quantity: 10,
          payoutPerShare: 1,
          payoutAmount: 10,
          ledgerTransactionId: null,
          idempotencyKey: `missing-ledger-ref-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/position_settlements_ledger_ref_consistency_check/);
  });

  it("rejects a zero payoutAmount that carries a ledgerTransactionId", async () => {
    const { market, yes, position } = await setupClosedMarketWithPosition();

    await expect(
      prisma.positionSettlement.create({
        data: {
          positionId: position.id,
          marketId: market.id,
          outcomeId: yes.id,
          userId: position.userId,
          quantity: 0,
          payoutPerShare: 1,
          payoutAmount: 0,
          ledgerTransactionId: "not-a-real-transaction-id",
          idempotencyKey: `dangling-ledger-ref-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/position_settlements_ledger_ref_consistency_check/);
  });

  it("enforces PositionSettlement.positionId uniqueness — a position can never be settled twice", async () => {
    const { market, yes, position } = await setupClosedMarketWithPosition();
    await prisma.positionSettlement.create({
      data: {
        positionId: position.id,
        marketId: market.id,
        outcomeId: yes.id,
        userId: position.userId,
        quantity: 10,
        payoutPerShare: 1,
        payoutAmount: 10,
        ledgerTransactionId: "tx-1",
        idempotencyKey: `settlement:${position.id}`,
      },
    });

    await expect(
      prisma.positionSettlement.create({
        data: {
          positionId: position.id,
          marketId: market.id,
          outcomeId: yes.id,
          userId: position.userId,
          quantity: 10,
          payoutPerShare: 1,
          payoutAmount: 10,
          ledgerTransactionId: "tx-2",
          idempotencyKey: `settlement-again:${position.id}`,
        },
      }),
    ).rejects.toThrow(/Unique constraint failed.*positionId/s);
  });

  it("enforces MarketResolution.marketId uniqueness — a market can never be resolved twice at the database level", async () => {
    const admin = await createTestAdmin();
    const { market, yes, no } = await createTestMarket(admin.id);
    await prisma.marketResolution.create({ data: { marketId: market.id, winningOutcomeId: yes.id, resolverId: admin.id } });

    await expect(
      prisma.marketResolution.create({ data: { marketId: market.id, winningOutcomeId: no.id, resolverId: admin.id } }),
    ).rejects.toThrow(/Unique constraint failed.*marketId/s);
  });

  it("rejects settledAt earlier than resolvedAt on a MarketResolution", async () => {
    const admin = await createTestAdmin();
    const { market, yes } = await createTestMarket(admin.id);
    const resolvedAt = new Date();
    const beforeResolvedAt = new Date(resolvedAt.getTime() - 60_000);

    await expect(
      prisma.marketResolution.create({
        data: { marketId: market.id, winningOutcomeId: yes.id, resolverId: admin.id, resolvedAt, settledAt: beforeResolvedAt },
      }),
    ).rejects.toThrow(/market_resolutions_settled_after_resolved_check/);
  });
});
