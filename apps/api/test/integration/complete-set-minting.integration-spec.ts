import {
  createTestMarket,
  createTestSuperAdmin,
  createTestUser,
  fundUserForTest,
  getUserAccount,
  ledger,
  openMarketForTest,
  ordersService,
  prisma,
  resolutionService,
} from "./helpers";

async function placeBuy(userId: string, marketId: string, outcomeId: string, price: string, quantity: string, clientOrderId?: string) {
  return ordersService.create(userId, { marketId, outcomeId, side: "BUY", type: "LIMIT", price, quantity, clientOrderId } as never);
}

/**
 * End-to-end proof that complete-set minting (Phase 12A) actually closes
 * the "no genesis mechanism" gap the audit found: a BUY-YES order and a
 * complementary BUY-NO order, with no pre-existing inventory on either
 * side (deliberately never using grantPositionForTest here), mint real,
 * collateral-backed shares through the real OrdersService/
 * ExecutionCoordinator path — the same path a real user's order takes.
 */
describe("Complete-set minting (real Postgres)", () => {
  it("mints a complete set from two complementary BUY orders with no pre-existing inventory on either side", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes, no } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const buyerA = await createTestUser();
    const buyerB = await createTestUser();
    await fundUserForTest(buyerA.id, "USDC", "100");
    await fundUserForTest(buyerB.id, "USDC", "100");

    // Resting BUY-NO @ 0.4 first, then an incoming BUY-YES @ 0.6 crosses it.
    await placeBuy(buyerB.id, market.id, no.id, "0.4", "10");
    await placeBuy(buyerA.id, market.id, yes.id, "0.6", "10");

    const mint = await prisma.completeSetMint.findFirstOrThrow({ where: { marketId: market.id } });
    expect(mint.priceA.toString()).toBe("0.6");
    expect(mint.priceB.toString()).toBe("0.4");
    expect(mint.quantity.toString()).toBe("10");

    const positionA = await prisma.position.findUniqueOrThrow({
      where: { userId_marketId_outcomeId: { userId: buyerA.id, marketId: market.id, outcomeId: yes.id } },
    });
    const positionB = await prisma.position.findUniqueOrThrow({
      where: { userId_marketId_outcomeId: { userId: buyerB.id, marketId: market.id, outcomeId: no.id } },
    });
    expect(positionA.quantity.toString()).toBe("10");
    expect(positionB.quantity.toString()).toBe("10");

    // Real collateral: exactly $1 per share was locked, in the market's
    // OWN account — never a house account, never fabricated.
    const collateral = await ledger.getMarketCollateralBalance(market.id, "USDC");
    expect(collateral.toString()).toBe("10");

    // Both buyers' cash moved by exactly their own price * quantity.
    expect((await getUserAccount(buyerA.id, "USDC"))?.cachedBalance.toString()).toBe("94"); // 100 - 6
    expect((await getUserAccount(buyerB.id, "USDC"))?.cachedBalance.toString()).toBe("96"); // 100 - 4

    const bothOrders = await prisma.order.findMany({ where: { marketId: market.id } });
    expect(bothOrders.every((o) => o.status === "FILLED")).toBe(true);
  });

  it("gives the incoming (taker) side price improvement — pays only the complement of the maker's price, never its own worse limit", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes, no } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const buyerA = await createTestUser();
    const buyerB = await createTestUser();
    await fundUserForTest(buyerA.id, "USDC", "100");
    await fundUserForTest(buyerB.id, "USDC", "100");

    await placeBuy(buyerB.id, market.id, no.id, "0.4", "10"); // resting maker
    await placeBuy(buyerA.id, market.id, yes.id, "0.9", "10"); // willing to pay up to 0.9

    const mint = await prisma.completeSetMint.findFirstOrThrow({ where: { marketId: market.id } });
    expect(mint.priceB.toString()).toBe("0.4"); // maker's own price, exactly
    expect(mint.priceA.toString()).toBe("0.6"); // 1 - 0.4, NOT 0.9 — real price improvement
    expect((await getUserAccount(buyerA.id, "USDC"))?.cachedBalance.toString()).toBe("94"); // paid 6, not 9
  });

  it("partial fill: an oversized incoming order mints only what the resting order can back, leaving the rest resting", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes, no } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const buyerA = await createTestUser();
    const buyerB = await createTestUser();
    await fundUserForTest(buyerA.id, "USDC", "100");
    await fundUserForTest(buyerB.id, "USDC", "100");

    await placeBuy(buyerB.id, market.id, no.id, "0.5", "5");
    const orderA = await placeBuy(buyerA.id, market.id, yes.id, "0.5", "20");

    const mint = await prisma.completeSetMint.findFirstOrThrow({ where: { marketId: market.id } });
    expect(mint.quantity.toString()).toBe("5");

    const refreshedA = await prisma.order.findUniqueOrThrow({ where: { id: orderA.id } });
    expect(refreshedA.status).toBe("PARTIALLY_FILLED");
    expect(refreshedA.remainingQuantity.toString()).toBe("15"); // still resting, waiting for more NO liquidity
  });

  it("prefers existing same-outcome inventory over minting when both are available", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes, no } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const seller = await createTestUser();
    const complementaryBuyer = await createTestUser();
    const incomingBuyer = await createTestUser();

    // Seller already holds real YES shares (minted in a prior round-trip,
    // not fabricated) — set up via a real mint first.
    await fundUserForTest(seller.id, "USDC", "100");
    await fundUserForTest(complementaryBuyer.id, "USDC", "100");
    await fundUserForTest(incomingBuyer.id, "USDC", "100");
    await placeBuy(complementaryBuyer.id, market.id, no.id, "0.5", "10");
    await placeBuy(seller.id, market.id, yes.id, "0.5", "10"); // mints 10 YES to seller

    // Now seller places a resting SELL of those real shares, and a second
    // complementary NO buyer is also resting — the incoming YES buyer
    // must take the cheaper real inventory, not mint a fresh set.
    await ordersService.create(seller.id, {
      marketId: market.id,
      outcomeId: yes.id,
      side: "SELL",
      type: "LIMIT",
      price: "0.3",
      quantity: "10",
    } as never);
    const secondComplementaryBuyer = await createTestUser();
    await fundUserForTest(secondComplementaryBuyer.id, "USDC", "100");
    await placeBuy(secondComplementaryBuyer.id, market.id, no.id, "0.9", "10"); // would happily mint at 0.9

    const collateralBefore = await ledger.getMarketCollateralBalance(market.id, "USDC");

    await placeBuy(incomingBuyer.id, market.id, yes.id, "0.9", "10");

    const fill = await prisma.fill.findFirst({ where: { marketId: market.id, buyerUserId: incomingBuyer.id } });
    expect(fill).not.toBeNull();
    expect(fill!.price.toString()).toBe("0.3"); // took the real inventory at the seller's price

    const collateralAfter = await ledger.getMarketCollateralBalance(market.id, "USDC");
    expect(collateralAfter.toString()).toBe(collateralBefore.toString()); // no new mint occurred
  });

  it("does not attempt minting for a market with more than 2 outcomes — SELL orders there still require real inventory", async () => {
    const admin = await createTestSuperAdmin();
    const category = await prisma.marketCategory.create({ data: { slug: `test-cat-3outcome-${Date.now()}`, name: "Test" } });
    const market = await prisma.market.create({
      data: {
        slug: `test-market-3outcome-${Date.now()}`,
        title: "Three-way market",
        description: "test",
        categoryId: category.id,
        createdById: admin.id,
        status: "OPEN",
        outcomes: { create: [{ key: "A", label: "A", sortOrder: 0 }, { key: "B", label: "B", sortOrder: 1 }, { key: "C", label: "C", sortOrder: 2 }] },
      },
      include: { outcomes: true },
    });
    const outcomeA = market.outcomes.find((o) => o.key === "A")!;
    const outcomeB = market.outcomes.find((o) => o.key === "B")!;

    const buyerA = await createTestUser();
    const buyerB = await createTestUser();
    await fundUserForTest(buyerA.id, "USDC", "100");
    await fundUserForTest(buyerB.id, "USDC", "100");

    await placeBuy(buyerB.id, market.id, outcomeB.id, "0.4", "10");
    await placeBuy(buyerA.id, market.id, outcomeA.id, "0.6", "10");

    expect(await prisma.completeSetMint.count({ where: { marketId: market.id } })).toBe(0);
    const collateral = await ledger.getMarketCollateralBalance(market.id, "USDC");
    expect(collateral.toString()).toBe("0");
  });

  it("self-minting is rejected: a user's own two complementary orders never cross", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes, no } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const trader = await createTestUser();
    await fundUserForTest(trader.id, "USDC", "100");

    await placeBuy(trader.id, market.id, no.id, "0.4", "10");
    await placeBuy(trader.id, market.id, yes.id, "0.6", "10");

    expect(await prisma.completeSetMint.count({ where: { marketId: market.id } })).toBe(0);
  });

  it("full lifecycle: minted shares settle correctly, and the market's collateral account reaches exactly zero after paying the winner", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes, no } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const buyerYes = await createTestUser();
    const buyerNo = await createTestUser();
    await fundUserForTest(buyerYes.id, "USDC", "100");
    await fundUserForTest(buyerNo.id, "USDC", "100");

    await placeBuy(buyerNo.id, market.id, no.id, "0.4", "10");
    await placeBuy(buyerYes.id, market.id, yes.id, "0.6", "10");

    const collateralAfterMint = await ledger.getMarketCollateralBalance(market.id, "USDC");
    expect(collateralAfterMint.toString()).toBe("10");

    const { marketsService } = await import("./helpers");
    await marketsService.close(market.id, admin.id);
    await resolutionService.resolve(market.id, admin.id, yes.id);

    // Winner (YES) is paid exactly their quantity * payoutPerShare(1),
    // funded entirely by the market's own collateral — never a house
    // account. Loser (NO) receives nothing.
    expect((await getUserAccount(buyerYes.id, "USDC"))?.cachedBalance.toString()).toBe("104"); // 94 + 10 payout
    expect((await getUserAccount(buyerNo.id, "USDC"))?.cachedBalance.toString()).toBe("96"); // unchanged from mint cost — no payout

    const collateralAfterSettlement = await ledger.getMarketCollateralBalance(market.id, "USDC");
    expect(collateralAfterSettlement.toString()).toBe("0"); // fully and exactly consumed — no leftover, no shortfall
  });

  it("idempotency: retrying matching for the same orders never double-mints", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes, no } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const buyerA = await createTestUser();
    const buyerB = await createTestUser();
    await fundUserForTest(buyerA.id, "USDC", "100");
    await fundUserForTest(buyerB.id, "USDC", "100");

    await placeBuy(buyerB.id, market.id, no.id, "0.4", "10");
    const orderA = await placeBuy(buyerA.id, market.id, yes.id, "0.6", "10");

    expect(await prisma.completeSetMint.count({ where: { marketId: market.id } })).toBe(1);

    // Retrying matching for an already-FILLED order must be a safe no-op.
    await ordersService.retryMatching(buyerA.id, orderA.id);

    expect(await prisma.completeSetMint.count({ where: { marketId: market.id } })).toBe(1);
    expect((await getUserAccount(buyerA.id, "USDC"))?.cachedBalance.toString()).toBe("94"); // not double-debited
  });

  it("concurrent minting attempts against the same pair of resting orders never double-mint", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes, no } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const buyerA = await createTestUser();
    const buyerB = await createTestUser();
    await fundUserForTest(buyerA.id, "USDC", "100");
    await fundUserForTest(buyerB.id, "USDC", "100");

    await placeBuy(buyerB.id, market.id, no.id, "0.4", "10");
    const orderA = await placeBuy(buyerA.id, market.id, yes.id, "0.6", "10");

    const { executionCoordinator } = await import("./helpers");
    await Promise.allSettled([
      executionCoordinator.matchAndExecute(orderA.id),
      executionCoordinator.matchAndExecute(orderA.id),
      executionCoordinator.matchAndExecute(orderA.id),
    ]);

    expect(await prisma.completeSetMint.count({ where: { marketId: market.id } })).toBe(1);
    const collateral = await ledger.getMarketCollateralBalance(market.id, "USDC");
    expect(collateral.toString()).toBe("10"); // not 20 or 30
  });
});
