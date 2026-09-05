import {
  createTestMarket,
  createTestUser,
  fundUserForTest,
  getUserAccount,
  openMarketForTest,
  ordersService,
  prisma,
} from "./helpers";

describe("Order placement idempotency (real Postgres)", () => {
  it("a duplicate clientOrderId submitted sequentially returns the original order without re-reserving", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const yes = market.outcomes.find((o) => o.key === "YES")!;
    await fundUserForTest(trader.id, "USDC", "100");

    const clientOrderId = `retry-${Date.now()}`;
    const dto = { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5", clientOrderId } as never;

    const first = await ordersService.create(trader.id, dto);
    const second = await ordersService.create(trader.id, dto);

    expect(second.id).toBe(first.id);
    const orders = await prisma.order.findMany({ where: { userId: trader.id, clientOrderId } });
    expect(orders).toHaveLength(1);

    const account = await getUserAccount(trader.id, "USDC");
    expect(account?.reservedBalance.toString()).toBe("5"); // 10*0.5 reserved exactly once
  });

  it("concurrent duplicate clientOrderId submissions create exactly one order and reserve funds exactly once", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const yes = market.outcomes.find((o) => o.key === "YES")!;
    await fundUserForTest(trader.id, "USDC", "100");

    const clientOrderId = `concurrent-retry-${Date.now()}`;
    const dto = { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5", clientOrderId } as never;

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => ordersService.create(trader.id, dto)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8); // all return successfully...

    const orderIds = new Set(
      (results as PromiseFulfilledResult<{ id: string }>[]).map((r) => r.value.id),
    );
    expect(orderIds.size).toBe(1); // ...but all resolve to the SAME order

    const orders = await prisma.order.findMany({ where: { userId: trader.id, clientOrderId } });
    expect(orders).toHaveLength(1);

    const account = await getUserAccount(trader.id, "USDC");
    expect(account?.reservedBalance.toString()).toBe("5"); // reserved exactly once, not 8 times
  });

  it("different clientOrderIds for the same user/market create genuinely separate orders", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const yes = market.outcomes.find((o) => o.key === "YES")!;
    await fundUserForTest(trader.id, "USDC", "100");

    const first = await ordersService.create(trader.id, {
      marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5", clientOrderId: "order-a",
    } as never);
    const second = await ordersService.create(trader.id, {
      marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5", clientOrderId: "order-b",
    } as never);

    expect(first.id).not.toBe(second.id);
    const account = await getUserAccount(trader.id, "USDC");
    expect(account?.reservedBalance.toString()).toBe("10"); // 5 + 5, both reserved
  });
});
