import { BadRequestException, NotFoundException } from "@nestjs/common";
import {
  createTestMarket,
  createTestUser,
  fundUserForTest,
  getUserAccount,
  openMarketForTest,
  ordersService,
  prisma,
} from "./helpers";

async function placeOrder(traderId: string, marketId: string, outcomeId: string) {
  return ordersService.create(traderId, {
    marketId,
    outcomeId,
    side: "BUY",
    type: "LIMIT",
    quantity: "20",
    price: "0.5",
  } as never);
}

describe("Order cancellation (real Postgres)", () => {
  it("rejects cancellation by a non-owner with NotFoundException (avoids a 403-vs-404 existence oracle — Phase 11 fix)", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const stranger = await createTestUser();
    const { market } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const yes = market.outcomes.find((o) => o.key === "YES")!;
    await fundUserForTest(trader.id, "USDC", "100");

    const order = await placeOrder(trader.id, market.id, yes.id);
    await expect(ordersService.cancel(stranger.id, order.id)).rejects.toThrow(NotFoundException);
  });

  it("rejects cancelling an already-terminal order", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const yes = market.outcomes.find((o) => o.key === "YES")!;
    await fundUserForTest(trader.id, "USDC", "100");

    const order = await placeOrder(trader.id, market.id, yes.id);
    await ordersService.cancel(trader.id, order.id);

    await expect(ordersService.cancel(trader.id, order.id)).rejects.toThrow(BadRequestException);
  });

  it("cancel vs fill boundary: an order that has moved to FILLED cannot be cancelled", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const yes = market.outcomes.find((o) => o.key === "YES")!;
    await fundUserForTest(trader.id, "USDC", "100");

    const order = await placeOrder(trader.id, market.id, yes.id);
    // No matching engine exists yet to produce this transition for real —
    // simulate its end state directly, test-only, to prove the boundary.
    await prisma.order.update({ where: { id: order.id }, data: { status: "FILLED", filledQuantity: order.quantity, remainingQuantity: 0 } });

    await expect(ordersService.cancel(trader.id, order.id)).rejects.toThrow(BadRequestException);
  });

  it("only one of two concurrent cancel attempts on the same order succeeds, and the reservation is released exactly once", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const yes = market.outcomes.find((o) => o.key === "YES")!;
    await fundUserForTest(trader.id, "USDC", "100");

    const order = await placeOrder(trader.id, market.id, yes.id);

    const results = await Promise.allSettled([
      ordersService.cancel(trader.id, order.id),
      ordersService.cancel(trader.id, order.id),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const account = await getUserAccount(trader.id, "USDC");
    expect(account?.reservedBalance.toString()).toBe("0"); // released exactly once, not double-released
    expect(account?.cachedBalance.toString()).toBe("100");
  });
});
