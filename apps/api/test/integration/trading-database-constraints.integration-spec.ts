import { createTestMarket, createTestUser, prisma } from "./helpers";

describe("Trading-foundation database invariants (real Postgres)", () => {
  it("rejects remainingQuantity greater than quantity", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);

    await expect(
      prisma.order.create({
        data: {
          userId: trader.id,
          marketId: market.id,
          outcomeId: yes.id,
          side: "BUY",
          type: "LIMIT",
          price: "0.5",
          quantity: "10",
          filledQuantity: 0,
          remainingQuantity: 20, // > quantity
          clientOrderId: `bad-remaining-${Date.now()}`,
        },
      }),
      // remainingQuantity > quantity necessarily also breaks
      // filled+remaining=quantity for any non-negative filledQuantity, so
      // either CHECK may be the one Postgres reports first — both are a
      // correct rejection of this row.
    ).rejects.toThrow(/orders_(remaining_quantity_bounds|filled_plus_remaining)_check/);
  });

  it("rejects filledQuantity + remainingQuantity != quantity", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);

    await expect(
      prisma.order.create({
        data: {
          userId: trader.id,
          marketId: market.id,
          outcomeId: yes.id,
          side: "BUY",
          type: "LIMIT",
          price: "0.5",
          quantity: "10",
          filledQuantity: 3,
          remainingQuantity: 3, // 3 + 3 != 10
          clientOrderId: `bad-sum-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/orders_filled_plus_remaining_check/);
  });

  it("enforces clientOrderId uniqueness per user at the database level", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    const clientOrderId = `dup-${Date.now()}`;

    const base = {
      userId: trader.id,
      marketId: market.id,
      outcomeId: yes.id,
      side: "BUY" as const,
      type: "LIMIT" as const,
      price: "0.5",
      quantity: "10",
      filledQuantity: 0,
      remainingQuantity: 10,
      clientOrderId,
    };

    await prisma.order.create({ data: base });
    // Prisma's typed API translates the P2002 into a friendly message
    // naming the fields, not the raw Postgres constraint name (that raw
    // name only surfaces through $queryRaw/$executeRaw, used elsewhere in
    // this suite for constraints reached via raw SQL).
    await expect(prisma.order.create({ data: base })).rejects.toThrow(/Unique constraint failed.*userId.*clientOrderId/s);
  });

  it("allows the same clientOrderId for two different users (scoped per user, not global)", async () => {
    const admin = await createTestUser();
    const traderA = await createTestUser();
    const traderB = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    const clientOrderId = `shared-${Date.now()}`;

    const makeOrder = (userId: string) => ({
      userId,
      marketId: market.id,
      outcomeId: yes.id,
      side: "BUY" as const,
      type: "LIMIT" as const,
      price: "0.5",
      quantity: "10",
      filledQuantity: 0,
      remainingQuantity: 10,
      clientOrderId,
    });

    await expect(prisma.order.create({ data: makeOrder(traderA.id) })).resolves.toBeDefined();
    await expect(prisma.order.create({ data: makeOrder(traderB.id) })).resolves.toBeDefined();
  });

  it("rejects reservedQuantity greater than quantity on a position", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);

    await expect(
      prisma.position.create({
        data: { userId: trader.id, marketId: market.id, outcomeId: yes.id, quantity: 10, reservedQuantity: 20 },
      }),
    ).rejects.toThrow(/positions_reserved_bounds_check/);
  });

  it("rejects a non-positive position reservation amount", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    const position = await prisma.position.create({
      data: { userId: trader.id, marketId: market.id, outcomeId: yes.id, quantity: 10, reservedQuantity: 0 },
    });

    await expect(
      prisma.positionReservation.create({
        data: {
          positionId: position.id,
          amount: 0,
          referenceType: "Test",
          referenceId: "t-1",
          idempotencyKey: `bad-amount-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/position_reservations_amount_positive_check/);
  });

  it("enforces unique outcome key within a market", async () => {
    const admin = await createTestUser();
    const { market } = await createTestMarket(admin.id);

    await expect(
      prisma.marketOutcome.create({ data: { marketId: market.id, key: "YES", label: "Duplicate Yes" } }),
    ).rejects.toThrow(/Unique constraint failed.*marketId.*key/s);
  });

  it("rejects a negative market maxExposure", async () => {
    const admin = await createTestUser();
    const { market } = await createTestMarket(admin.id);

    await expect(
      prisma.market.update({ where: { id: market.id }, data: { maxExposure: -1 } }),
    ).rejects.toThrow(/markets_max_exposure_non_negative_check/);
  });

  it("rejects negative maxOrderQuantity/maxOrderNotional on a risk limit", async () => {
    const trader = await createTestUser();

    await expect(
      prisma.riskLimit.create({ data: { userId: trader.id, maxOrderQuantity: -5 } }),
    ).rejects.toThrow(/risk_limits_order_limits_non_negative_check/);
  });
});
