import {
  createTestMarket,
  createTestUser,
  fundUserForTest,
  grantPositionForTest,
  openMarketForTest,
  ordersService,
  positionsService,
  prisma,
} from "./helpers";

/**
 * No matching engine exists in this phase, so a Fill is never produced
 * by the running app here — these tests exercise the Fill model exactly
 * the way the future matcher/execution-coordinator will: a direct,
 * immutable insert once per real execution. That is what proves the
 * idempotency protection actually works, independent of whoever ends up
 * calling it.
 */
describe("Fills and positions (real Postgres)", () => {
  it("records a fill referencing the buy/sell orders and both parties", async () => {
    const admin = await createTestUser();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "50");

    const buyOrder = await ordersService.create(buyer.id, {
      marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5",
    } as never);
    const sellOrder = await ordersService.create(seller.id, {
      marketId: market.id, outcomeId: yes.id, side: "SELL", type: "LIMIT", quantity: "10", price: "0.5",
    } as never);

    const fill = await prisma.fill.create({
      data: {
        marketId: market.id,
        outcomeId: yes.id,
        buyOrderId: buyOrder.id,
        sellOrderId: sellOrder.id,
        buyerUserId: buyer.id,
        sellerUserId: seller.id,
        price: "0.5",
        quantity: "10",
        idempotencyKey: `fill:${buyOrder.id}:${sellOrder.id}:1`,
      },
    });

    expect(fill.buyOrderId).toBe(buyOrder.id);
    expect(fill.sellOrderId).toBe(sellOrder.id);
    expect(fill.quantity.toString()).toBe("10");
  });

  it("enforces fill idempotency at the database level — the same execution cannot be applied twice", async () => {
    const admin = await createTestUser();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "50");

    const buyOrder = await ordersService.create(buyer.id, {
      marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5",
    } as never);
    const sellOrder = await ordersService.create(seller.id, {
      marketId: market.id, outcomeId: yes.id, side: "SELL", type: "LIMIT", quantity: "10", price: "0.5",
    } as never);

    const idempotencyKey = `fill:${buyOrder.id}:${sellOrder.id}:1`;
    const fillData = {
      marketId: market.id,
      outcomeId: yes.id,
      buyOrderId: buyOrder.id,
      sellOrderId: sellOrder.id,
      buyerUserId: buyer.id,
      sellerUserId: seller.id,
      price: "0.5",
      quantity: "10",
      idempotencyKey,
    };

    await prisma.fill.create({ data: fillData });
    await expect(prisma.fill.create({ data: fillData })).rejects.toThrow(/idempotencyKey/);

    const fills = await prisma.fill.findMany({ where: { idempotencyKey } });
    expect(fills).toHaveLength(1);
  });

  it("rejects a fill where the buy and sell order are the same order (self-trade)", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await fundUserForTest(trader.id, "USDC", "100");

    const order = await ordersService.create(trader.id, {
      marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5",
    } as never);

    await expect(
      prisma.fill.create({
        data: {
          marketId: market.id,
          outcomeId: yes.id,
          buyOrderId: order.id,
          sellOrderId: order.id,
          buyerUserId: trader.id,
          sellerUserId: trader.id,
          price: "0.5",
          quantity: "10",
          idempotencyKey: `fill:self-trade:${order.id}`,
        },
      }),
    ).rejects.toThrow(/fills_buy_sell_distinct_check/);
  });

  it("aggregates positions by user across markets/outcomes", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market: marketA, yes: yesA } = await createTestMarket(admin.id);
    const { market: marketB, yes: yesB } = await createTestMarket(admin.id);
    await grantPositionForTest(trader.id, marketA.id, yesA.id, "30");
    await grantPositionForTest(trader.id, marketB.id, yesB.id, "70");

    const positions = await positionsService.listMine(trader.id);
    expect(positions).toHaveLength(2);
    const quantities = positions.map((p) => p.quantity.toString()).sort();
    expect(quantities).toEqual(["30", "70"]);
  });
});
