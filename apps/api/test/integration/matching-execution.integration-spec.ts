import { Prisma } from "@prisma/client";
import { ExecutionCoordinator } from "../../src/trading/execution/execution-coordinator.service";
import { OrdersService } from "../../src/trading/orders.service";
import { MatchingAttemptFailedException } from "../../src/trading/trading.errors";
import {
  createTestMarket,
  createTestUser,
  executionCoordinator,
  feeCalculator,
  fundUserForTest,
  getUserAccount,
  grantPositionForTest,
  openMarketForTest,
  orderRiskValidator,
  ordersService,
  positionReservations,
  prisma,
  reservations,
  txRunner,
} from "./helpers";

async function setup(overrides: { closeTime?: string } = {}) {
  const admin = await createTestUser();
  const { market, yes } = await createTestMarket(admin.id, overrides);
  await openMarketForTest(market.id, admin.id);
  return { admin, market, yes };
}

async function buy(userId: string, marketId: string, outcomeId: string, quantity: string, price: string, clientOrderId?: string) {
  return ordersService.create(userId, { marketId, outcomeId, side: "BUY", type: "LIMIT", quantity, price, clientOrderId } as never);
}

async function sell(userId: string, marketId: string, outcomeId: string, quantity: string, price: string, clientOrderId?: string) {
  return ordersService.create(userId, { marketId, outcomeId, side: "SELL", type: "LIMIT", quantity, price, clientOrderId } as never);
}

async function fillsFor(orderId: string) {
  return prisma.fill.findMany({ where: { OR: [{ buyOrderId: orderId }, { sellOrderId: orderId }] }, orderBy: { executedAt: "asc" } });
}

/**
 * Places a resting order via the SAME real reservation primitives
 * OrdersService.create() uses, but WITHOUT its automatic post-funding
 * matchAndExecute call — so the order provably rests unmatched, and the
 * test can then trigger (possibly concurrent, possibly repeated)
 * matchAndExecute calls itself to construct a specific race deliberately.
 */
async function placeRestingOrderNoAutoMatch(
  userId: string,
  marketId: string,
  outcomeId: string,
  side: "BUY" | "SELL",
  quantity: string,
  price: string,
) {
  return txRunner.run(async (tx) => {
    const order = await tx.order.create({
      data: {
        userId,
        marketId,
        outcomeId,
        side,
        type: "LIMIT",
        price,
        quantity,
        filledQuantity: 0,
        remainingQuantity: quantity,
        status: "OPEN",
        clientOrderId: `no-automatch-${Date.now()}-${Math.random()}`,
      },
    });

    if (side === "BUY") {
      await reservations.reserve(tx, {
        userId,
        assetSymbol: "USDC",
        amount: new Prisma.Decimal(quantity).times(price),
        referenceType: "Order",
        referenceId: order.id,
        idempotencyKey: `order-reserve:${order.id}`,
      });
    } else {
      await positionReservations.reserve(tx, {
        userId,
        marketId,
        outcomeId,
        amount: quantity,
        referenceType: "Order",
        referenceId: order.id,
        idempotencyKey: `order-reserve:${order.id}`,
      });
    }

    return order;
  });
}

describe("Matching engine + execution coordinator (real Postgres)", () => {
  it("executes a simple full fill when a crossing order arrives", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "10");

    // buyOrder rests first, unmatched (no counterpart exists yet) — its
    // return value here is a pre-cross snapshot. sellOrder's own return
    // value DOES reflect the cross (it was the taker), so we re-fetch
    // buyOrder to see how it looks after being matched as the maker.
    const placedBuyOrder = await buy(buyer.id, market.id, yes.id, "10", "0.5");
    const sellOrder = await sell(seller.id, market.id, yes.id, "10", "0.5");
    const buyOrder = await prisma.order.findUniqueOrThrow({ where: { id: placedBuyOrder.id } });

    expect(buyOrder.status).toBe("FILLED");
    expect(sellOrder.status).toBe("FILLED");
    expect(buyOrder.remainingQuantity.toString()).toBe("0");
    expect(sellOrder.remainingQuantity.toString()).toBe("0");

    const fills = await fillsFor(buyOrder.id);
    expect(fills).toHaveLength(1);
    expect(fills[0].price.toString()).toBe("0.5");
    expect(fills[0].quantity.toString()).toBe("10");
    expect(fills[0].makerOrderId).toBe(buyOrder.id); // buyer was resting first, seller crossed it
    expect(fills[0].takerOrderId).toBe(sellOrder.id);
  });

  it("executes a partial fill, leaving the larger order resting with the correct remainder", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "10");

    const sellOrder = await sell(seller.id, market.id, yes.id, "10", "0.5");
    const buyOrder = await buy(buyer.id, market.id, yes.id, "30", "0.5"); // larger than the resting sell

    expect(sellOrder.status).toBe("OPEN"); // hasn't been re-fetched — placed before the cross
    const refreshedSell = await prisma.order.findUniqueOrThrow({ where: { id: sellOrder.id } });
    expect(refreshedSell.status).toBe("FILLED");

    expect(buyOrder.status).toBe("PARTIALLY_FILLED");
    expect(buyOrder.filledQuantity.toString()).toBe("10");
    expect(buyOrder.remainingQuantity.toString()).toBe("20");
    // filled + remaining always reconstructs the original size
    expect(buyOrder.filledQuantity.plus(buyOrder.remainingQuantity).toString()).toBe(buyOrder.quantity.toString());
  });

  it("consumes multiple resting price levels for one large incoming order", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const sellerA = await createTestUser();
    const sellerB = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(sellerA.id, market.id, yes.id, "10");
    await grantPositionForTest(sellerB.id, market.id, yes.id, "10");

    const sellA = await sell(sellerA.id, market.id, yes.id, "10", "0.4");
    const sellB = await sell(sellerB.id, market.id, yes.id, "10", "0.45");
    const buyOrder = await buy(buyer.id, market.id, yes.id, "20", "0.5");

    expect(buyOrder.status).toBe("FILLED");
    const fills = await fillsFor(buyOrder.id);
    expect(fills).toHaveLength(2);
    expect(fills.map((f) => [f.makerOrderId, f.price.toString(), f.quantity.toString()])).toEqual([
      [sellA.id, "0.4", "10"], // best price first
      [sellB.id, "0.45", "10"],
    ]);
  });

  it("produces multiple fills from one order sweeping several counterparties, each an independent Fill row", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const sellers = await Promise.all([createTestUser(), createTestUser(), createTestUser()]);
    await fundUserForTest(buyer.id, "USDC", "100");
    await Promise.all(sellers.map((s) => grantPositionForTest(s.id, market.id, yes.id, "5")));

    for (const s of sellers) {
      await sell(s.id, market.id, yes.id, "5", "0.5");
    }
    const buyOrder = await buy(buyer.id, market.id, yes.id, "15", "0.5");

    expect(buyOrder.status).toBe("FILLED");
    const fills = await fillsFor(buyOrder.id);
    expect(fills).toHaveLength(3);
    expect(new Set(fills.map((f) => f.idempotencyKey)).size).toBe(3); // each independently keyed
  });

  it("consumes exactly the executed quantity from the buyer's cash reservation and seller's share reservation", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "20");

    const sellOrder = await sell(seller.id, market.id, yes.id, "20", "0.5");
    await buy(buyer.id, market.id, yes.id, "8", "0.5"); // fully filled — only 8 of the seller's 20 consumed

    const buyerAccount = await getUserAccount(buyer.id, "USDC");
    expect(buyerAccount?.reservedBalance.toString()).toBe("0"); // 8*0.5=4 reserved, all of it consumed (order fully filled)

    const sellerPosition = await prisma.position.findUniqueOrThrow({
      where: { userId_marketId_outcomeId: { userId: seller.id, marketId: market.id, outcomeId: yes.id } },
    });
    expect(sellerPosition.reservedQuantity.toString()).toBe("12"); // 20 - 8 consumed

    const sellReservation = await prisma.positionReservation.findFirstOrThrow({ where: { referenceType: "Order", referenceId: sellOrder.id } });
    expect(sellReservation.consumedAmount.toString()).toBe("8");
    expect(sellReservation.status).toBe("ACTIVE"); // still resting for the remaining 12
  });

  it("leaves the remainder of a partially-filled order's reservation available for the rest of the order", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "5");

    const buyOrder = await buy(buyer.id, market.id, yes.id, "20", "0.5"); // reserves 10
    await sell(seller.id, market.id, yes.id, "5", "0.5"); // partially fills 5 of the 20

    const buyReservation = await prisma.fundReservation.findFirstOrThrow({ where: { referenceType: "Order", referenceId: buyOrder.id } });
    expect(buyReservation.consumedAmount.toString()).toBe("2.5"); // 5 * 0.5
    expect(buyReservation.amount.toString()).toBe("10"); // original 20*0.5
    expect(buyReservation.status).toBe("ACTIVE");

    // Cancelling now should release exactly the unconsumed remainder (7.5), not the full original 10.
    await ordersService.cancel(buyer.id, buyOrder.id);
    const account = await getUserAccount(buyer.id, "USDC");
    expect(account?.reservedBalance.toString()).toBe("0"); // 2.5 stayed consumed (spent), 7.5 released — nothing double-counted
  });

  it("preserves the buyer's price improvement — the buyer pays the better resting price, not their own limit", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "40");

    await sell(seller.id, market.id, yes.id, "40", "0.6");
    const buyOrder = await buy(buyer.id, market.id, yes.id, "100", "0.7"); // willing to pay up to 0.7

    const fills = await fillsFor(buyOrder.id);
    expect(fills[0].price.toString()).toBe("0.6"); // not 0.7, not the 0.65 midpoint

    const buyerAccount = await getUserAccount(buyer.id, "USDC");
    // Reserved 100*0.7=70 up front; actual cost so far is 40*0.6=24, so
    // 70-24=46 remains reserved for the still-open 60 remaining quantity —
    // the 0.10/share improvement was never silently destroyed.
    expect(buyerAccount?.reservedBalance.toString()).toBe("46");
    expect(buyerAccount?.cachedBalance.toString()).toBe("76"); // 100 - (40*0.6) real cash actually moved via the trade
  });

  it("credits the seller's cash proceeds through the authoritative ledger, not a parallel balance", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "10");

    await sell(seller.id, market.id, yes.id, "10", "0.5");
    const buyOrder = await buy(buyer.id, market.id, yes.id, "10", "0.5");

    const sellerAccount = await getUserAccount(seller.id, "USDC");
    expect(sellerAccount?.cachedBalance.toString()).toBe("5"); // 10 * 0.5, credited via LedgerService
    const buyerAccount = await getUserAccount(buyer.id, "USDC");
    expect(buyerAccount?.cachedBalance.toString()).toBe("95"); // 100 - 5

    const [fill] = await fillsFor(buyOrder.id);
    const entries = await prisma.ledgerEntry.findMany({
      where: { transaction: { referenceType: "Fill", referenceId: fill.id } },
    });
    const amounts = entries.map((e) => e.amount.toString()).sort();
    expect(amounts).toEqual(["-5", "5"]); // balanced double-entry posting, scoped to this exact trade
  });

  it("updates both positions correctly: buyer quantity increases, seller quantity decreases", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "10");

    await sell(seller.id, market.id, yes.id, "10", "0.5");
    await buy(buyer.id, market.id, yes.id, "10", "0.5");

    const buyerPosition = await prisma.position.findUniqueOrThrow({
      where: { userId_marketId_outcomeId: { userId: buyer.id, marketId: market.id, outcomeId: yes.id } },
    });
    expect(buyerPosition.quantity.toString()).toBe("10");
    expect(buyerPosition.avgPrice.toString()).toBe("0.5");

    const sellerPosition = await prisma.position.findUniqueOrThrow({
      where: { userId_marketId_outcomeId: { userId: seller.id, marketId: market.id, outcomeId: yes.id } },
    });
    expect(sellerPosition.quantity.toString()).toBe("0");
    expect(sellerPosition.reservedQuantity.toString()).toBe("0");
  });

  it("computes weighted-average cost basis across two separate BUY fills at different prices", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const sellerA = await createTestUser();
    const sellerB = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(sellerA.id, market.id, yes.id, "10");
    await grantPositionForTest(sellerB.id, market.id, yes.id, "10");

    await sell(sellerA.id, market.id, yes.id, "10", "0.4");
    await sell(sellerB.id, market.id, yes.id, "10", "0.6");
    await buy(buyer.id, market.id, yes.id, "20", "0.6"); // crosses both

    const buyerPosition = await prisma.position.findUniqueOrThrow({
      where: { userId_marketId_outcomeId: { userId: buyer.id, marketId: market.id, outcomeId: yes.id } },
    });
    expect(buyerPosition.quantity.toString()).toBe("20");
    // (10*0.4 + 10*0.6) / 20 = 0.5
    expect(buyerPosition.avgPrice.toString()).toBe("0.5");
  });

  it("realizes P&L on the seller's disposal without touching settlement", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    // Seller's position starts with an implied avgPrice of 0 (test fixture grant, not a real buy) —
    // so the full sale price is "realized" here, illustrating the formula, not a real cost basis.
    await grantPositionForTest(seller.id, market.id, yes.id, "10");

    await sell(seller.id, market.id, yes.id, "10", "0.5");
    await buy(buyer.id, market.id, yes.id, "10", "0.5");

    const sellerPosition = await prisma.position.findUniqueOrThrow({
      where: { userId_marketId_outcomeId: { userId: seller.id, marketId: market.id, outcomeId: yes.id } },
    });
    expect(sellerPosition.realizedPnl.toString()).toBe("5"); // (0.5 - 0) * 10
  });

  it("charges no fee by default (ZeroFeeCalculator) — Fill.fee is zero and no FEE_REVENUE posting exists", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "10");

    await sell(seller.id, market.id, yes.id, "10", "0.5");
    const buyOrder = await buy(buyer.id, market.id, yes.id, "10", "0.5");

    const fills = await fillsFor(buyOrder.id);
    expect(fills[0].fee.toString()).toBe("0");

    // Scoped to this exact trade's own ledger transaction — other test
    // files in this shared-database suite may legitimately have their own
    // FEE_REVENUE account (e.g. withdrawal fees), so "does one exist
    // anywhere" isn't a safe assertion; "did THIS trade post to one" is.
    const entries = await prisma.ledgerEntry.findMany({
      where: { transaction: { referenceType: "Fill", referenceId: fills[0].id } },
      include: { account: true },
    });
    expect(entries).toHaveLength(2); // buyer debit, seller credit — no third FEE_REVENUE leg
    expect(entries.every((e) => e.account.houseAccountKey !== "FEE_REVENUE")).toBe(true);
  });

  it("rejects trading on a market that has closed since the resting order was placed", async () => {
    const { market, yes } = await setup();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "10");

    const sellOrder = await sell(seller.id, market.id, yes.id, "10", "0.5");
    await prisma.market.update({ where: { id: market.id }, data: { status: "CLOSED" } });

    // A new crossing BUY order can't even be placed once CLOSED (OrdersService
    // itself gates this) — but matchAndExecute must ALSO refuse to execute
    // a still-resting order once the market it belongs to is no longer OPEN.
    const result = await executionCoordinator.matchAndExecute(sellOrder.id);
    expect(result).toEqual([]);

    const refreshedSell = await prisma.order.findUniqueOrThrow({ where: { id: sellOrder.id } });
    expect(refreshedSell.status).toBe("OPEN"); // untouched, not incorrectly executed against a closed market
  });

  it("prevents self-trading: a user's own resting order is skipped, and their order rests against someone else's instead", async () => {
    const { market, yes } = await setup();
    const trader = await createTestUser();
    const otherSeller = await createTestUser();
    await fundUserForTest(trader.id, "USDC", "100");
    await grantPositionForTest(trader.id, market.id, yes.id, "10");
    await grantPositionForTest(otherSeller.id, market.id, yes.id, "10");

    const ownSell = await sell(trader.id, market.id, yes.id, "10", "0.4"); // better price, but same user
    await sell(otherSeller.id, market.id, yes.id, "10", "0.45");
    const buyOrder = await buy(trader.id, market.id, yes.id, "10", "0.5");

    const fills = await fillsFor(buyOrder.id);
    expect(fills).toHaveLength(1);
    expect(fills[0].price.toString()).toBe("0.45"); // the worse-priced OTHER seller, not the better-priced own order

    const untouchedOwnSell = await prisma.order.findUniqueOrThrow({ where: { id: ownSell.id } });
    expect(untouchedOwnSell.status).toBe("OPEN"); // never touched, never expired, never cancelled by this
    expect(untouchedOwnSell.remainingQuantity.toString()).toBe("10");
  });

  describe("concurrency", () => {
    it(
      "duplicate/concurrent matchAndExecute calls against the same crossing pair produce exactly one Fill " +
        "(race: two workers both discover the same crossable pair and race to apply it; invariant: Fill." +
        "idempotencyKey is derived only from the immutable maker/taker identity and is DB-unique, so only one " +
        "createIdempotent call can win — the other observes alreadyExisted and applies no side effects; a naive " +
        "'check then insert' without a DB uniqueness constraint would have let both workers apply their own copy)",
      async () => {
        const { market, yes } = await setup();
        const buyer = await createTestUser();
        const seller = await createTestUser();
        await fundUserForTest(buyer.id, "USDC", "100");
        await grantPositionForTest(seller.id, market.id, yes.id, "10");

        const buyOrder = await placeRestingOrderNoAutoMatch(buyer.id, market.id, yes.id, "BUY", "10", "0.5");
        const sellOrder = await placeRestingOrderNoAutoMatch(seller.id, market.id, yes.id, "SELL", "10", "0.5");

        const results = await Promise.allSettled([
          executionCoordinator.matchAndExecute(sellOrder.id),
          executionCoordinator.matchAndExecute(sellOrder.id),
        ]);
        expect(results.every((r) => r.status === "fulfilled")).toBe(true);

        const fills = await fillsFor(buyOrder.id);
        expect(fills).toHaveLength(1);
        expect(fills[0].quantity.toString()).toBe("10");

        const buyerAccount = await getUserAccount(buyer.id, "USDC");
        expect(buyerAccount?.reservedBalance.toString()).toBe("0"); // consumed exactly once, not twice
        const sellerAccount = await getUserAccount(seller.id, "USDC");
        expect(sellerAccount?.cachedBalance.toString()).toBe("5"); // credited exactly once
      },
    );

    it(
      "several concurrent taker orders competing for the same single resting order never over-allocate its liquidity " +
        "(race: N concurrent BUY orders all try to cross the SAME resting SELL of limited size; invariant: each " +
        "applyExecution transaction re-fetches the resting order's CURRENT remainingQuantity under SERIALIZABLE " +
        "before consuming it, so at most `resting quantity` total ever gets allocated across all takers combined; " +
        "an implementation that trusted the matcher's snapshot quantity without re-validating at execution time " +
        "would let every concurrent taker independently believe the full quantity was still available and " +
        "over-allocate it)",
      async () => {
        const { market, yes } = await setup();
        const seller = await createTestUser();
        await grantPositionForTest(seller.id, market.id, yes.id, "10");
        const sellOrder = await placeRestingOrderNoAutoMatch(seller.id, market.id, yes.id, "SELL", "10", "0.5");

        const buyers = await Promise.all(Array.from({ length: 5 }, () => createTestUser()));
        await Promise.all(buyers.map((b) => fundUserForTest(b.id, "USDC", "100")));
        const buyOrders = await Promise.all(
          buyers.map((b) => placeRestingOrderNoAutoMatch(b.id, market.id, yes.id, "BUY", "5", "0.5")),
        );

        // Each buyer's own order-placement flow would normally trigger
        // matching for just its own order; here we fire all 5 concurrently
        // against the SAME single resting seller to force the contention.
        await Promise.allSettled(buyOrders.map((o) => executionCoordinator.matchAndExecute(o.id)));

        const refreshedSell = await prisma.order.findUniqueOrThrow({ where: { id: sellOrder.id } });
        expect(refreshedSell.filledQuantity.toString()).toBe("10"); // exactly the resting quantity, never more
        expect(refreshedSell.remainingQuantity.toString()).toBe("0");

        const fills = await prisma.fill.findMany({ where: { sellOrderId: sellOrder.id } });
        const totalFilled = fills.reduce((sum, f) => sum.plus(f.quantity), new Prisma.Decimal(0));
        expect(totalFilled.toString()).toBe("10"); // sum across all winning buyers == exactly the resting liquidity

        const sellerPosition = await prisma.position.findUniqueOrThrow({
          where: { userId_marketId_outcomeId: { userId: seller.id, marketId: market.id, outcomeId: yes.id } },
        });
        expect(sellerPosition.quantity.toString()).toBe("0"); // exactly 10 shares left the seller, never more
      },
    );

    it(
      "cancel racing a fill: exactly one valid transition wins, never both " +
        "(race: cancel() and matchAndExecute() both act on the same resting order at nearly the same instant; " +
        "invariant: both paths gate on the SAME CAS — order.status IN (OPEN, PARTIALLY_FILLED) — under " +
        "SERIALIZABLE, so Postgres's own conflict detection ensures exactly one of {cancellation, fill} is the " +
        "one that actually changes the terminal state; an implementation that read status once and acted on a " +
        "stale copy could cancel an order that was already filled, or fill an order that was already cancelled, " +
        "releasing its reservation)",
      async () => {
        const { market, yes } = await setup();
        const buyer = await createTestUser();
        const seller = await createTestUser();
        await fundUserForTest(buyer.id, "USDC", "100");
        await grantPositionForTest(seller.id, market.id, yes.id, "10");

        const buyOrder = await placeRestingOrderNoAutoMatch(buyer.id, market.id, yes.id, "BUY", "10", "0.5");
        const sellOrder = await placeRestingOrderNoAutoMatch(seller.id, market.id, yes.id, "SELL", "10", "0.5");

        const results = await Promise.allSettled([
          ordersService.cancel(buyer.id, buyOrder.id),
          executionCoordinator.matchAndExecute(sellOrder.id),
        ]);
        expect(results.every((r) => r.status === "fulfilled")).toBe(true);

        const finalBuy = await prisma.order.findUniqueOrThrow({ where: { id: buyOrder.id } });
        // Exactly one of the two outcomes happened — never a state that
        // shows characteristics of both (e.g. CANCELLED with a Fill
        // referencing it, or FILLED with its reservation released).
        const fills = await fillsFor(buyOrder.id);
        const buyerAccount = await getUserAccount(buyer.id, "USDC");

        if (finalBuy.status === "CANCELLED") {
          expect(fills).toHaveLength(0);
          expect(buyerAccount?.reservedBalance.toString()).toBe("0"); // released, not consumed
          expect(buyerAccount?.cachedBalance.toString()).toBe("100"); // untouched
        } else {
          expect(finalBuy.status).toBe("FILLED");
          expect(fills).toHaveLength(1);
          expect(buyerAccount?.reservedBalance.toString()).toBe("0"); // consumed, not released
          expect(buyerAccount?.cachedBalance.toString()).toBe("95"); // the trade actually happened
        }
      },
    );

    it(
      "a stale ExecutionInstruction (generated from a snapshot the resting order no longer matches) is rejected/recomputed, never blindly applied " +
        "(race: candidate generation reads a snapshot of the resting order; before the corresponding applyExecution " +
        "transaction runs, a concurrent transaction shrinks that same resting order's remainingQuantity below what " +
        "the stale instruction assumed; invariant: applyExecution re-fetches both orders fresh at the START of its " +
        "own transaction and clamps the executed quantity to min(instruction quantity, CURRENT remaining on both " +
        "sides) — it never trusts the instruction's embedded quantity; a matcher/coordinator that executed the " +
        "instruction's original quantity verbatim would either overdraw the resting order's remainingQuantity " +
        "below zero or double-allocate shares that a concurrent transaction already claimed)",
      async () => {
        const { market, yes } = await setup();
        const buyer = await createTestUser();
        const seller = await createTestUser();
        const otherBuyer = await createTestUser();
        await fundUserForTest(buyer.id, "USDC", "100");
        await fundUserForTest(otherBuyer.id, "USDC", "100");
        await grantPositionForTest(seller.id, market.id, yes.id, "10");

        const sellOrder = await placeRestingOrderNoAutoMatch(seller.id, market.id, yes.id, "SELL", "10", "0.5");
        const buyOrder = await placeRestingOrderNoAutoMatch(buyer.id, market.id, yes.id, "BUY", "10", "0.5");

        // Simulate "another concurrent transaction already consumed part of
        // the resting sell order" by directly shrinking it between
        // candidate generation and execution — exactly what a genuinely
        // concurrent competing taker would have done, just performed
        // deterministically here instead of via real timing.
        await prisma.order.update({
          where: { id: sellOrder.id },
          data: { filledQuantity: "4", remainingQuantity: "6", status: "PARTIALLY_FILLED" },
        });

        await executionCoordinator.matchAndExecute(buyOrder.id);

        const finalSell = await prisma.order.findUniqueOrThrow({ where: { id: sellOrder.id } });
        const finalBuy = await prisma.order.findUniqueOrThrow({ where: { id: buyOrder.id } });
        expect(finalSell.remainingQuantity.toString()).toBe("0"); // never went negative
        expect(finalSell.status).toBe("FILLED");
        expect(finalBuy.filledQuantity.toString()).toBe("6"); // clamped to what was actually available, not the stale 10
        expect(finalBuy.remainingQuantity.toString()).toBe("4"); // rests with the true unfilled remainder

        const fills = await fillsFor(buyOrder.id);
        expect(fills).toHaveLength(1);
        expect(fills[0].quantity.toString()).toBe("6");
      },
    );

    it(
      "an instruction against a fully-consumed-in-the-meantime resting order is skipped entirely, not partially applied " +
        "(race: the resting order is fully filled/cancelled by something else between candidate generation and " +
        "execution; invariant: applyExecution's clamp — min(instruction quantity, current remaining) — reaches " +
        "zero, and the coordinator returns null without creating a Fill or touching any reservation; a coordinator " +
        "that didn't re-check current state would create a zero-or-negative-quantity Fill, which the DB CHECK " +
        "constraint on Fill.quantity > 0 would also independently catch)",
      async () => {
        const { market, yes } = await setup();
        const buyer = await createTestUser();
        const seller = await createTestUser();
        await fundUserForTest(buyer.id, "USDC", "100");
        await grantPositionForTest(seller.id, market.id, yes.id, "10");

        const sellOrder = await placeRestingOrderNoAutoMatch(seller.id, market.id, yes.id, "SELL", "10", "0.5");
        const buyOrder = await placeRestingOrderNoAutoMatch(buyer.id, market.id, yes.id, "BUY", "10", "0.5");

        await prisma.order.update({
          where: { id: sellOrder.id },
          data: { status: "CANCELLED" },
        });

        const result = await executionCoordinator.matchAndExecute(buyOrder.id);
        expect(result).toEqual([]);

        const finalBuy = await prisma.order.findUniqueOrThrow({ where: { id: buyOrder.id } });
        expect(finalBuy.status).toBe("OPEN"); // untouched — the only candidate was invalid
        expect(await fillsFor(buyOrder.id)).toHaveLength(0);
      },
    );

    it(
      "genuine Postgres serialization conflicts across concurrent applyExecution transactions are retried " +
        "(bounded, with backoff) rather than corrupting state or failing outright " +
        "(race: many concurrent taker orders all write to the SAME resting order row inside SERIALIZABLE " +
        "transactions; invariant: SerializableTransactionRunner — the same primitive every other financial " +
        "mutation in this codebase uses — retries a transaction Postgres aborted for serialization failure, so " +
        "contention shows up as latency/retries, never as a lost update or a corrupted balance)",
      async () => {
        const { market, yes } = await setup();
        const seller = await createTestUser();
        await grantPositionForTest(seller.id, market.id, yes.id, "20");
        const sellOrder = await placeRestingOrderNoAutoMatch(seller.id, market.id, yes.id, "SELL", "20", "0.5");

        const buyers = await Promise.all(Array.from({ length: 8 }, () => createTestUser()));
        await Promise.all(buyers.map((b) => fundUserForTest(b.id, "USDC", "100")));
        const buyOrders = await Promise.all(
          buyers.map((b) => placeRestingOrderNoAutoMatch(b.id, market.id, yes.id, "BUY", "5", "0.5")),
        );

        const results = await Promise.allSettled(buyOrders.map((o) => executionCoordinator.matchAndExecute(o.id)));
        expect(results.every((r) => r.status === "fulfilled")).toBe(true); // contention resolved via retry, not a thrown error

        const finalSell = await prisma.order.findUniqueOrThrow({ where: { id: sellOrder.id } });
        expect(finalSell.filledQuantity.toString()).toBe("20"); // fully, exactly consumed — no lost updates
        expect(finalSell.remainingQuantity.toString()).toBe("0");
      },
    );

    it("an undersized/corrupted reservation fails the execution loudly rather than silently under-consuming", async () => {
      const { market, yes } = await setup();
      const buyer = await createTestUser();
      const seller = await createTestUser();
      await fundUserForTest(buyer.id, "USDC", "100");
      await grantPositionForTest(seller.id, market.id, yes.id, "10");

      const buyOrder = await placeRestingOrderNoAutoMatch(buyer.id, market.id, yes.id, "BUY", "10", "0.5");
      const sellOrder = await placeRestingOrderNoAutoMatch(seller.id, market.id, yes.id, "SELL", "10", "0.5");

      // Simulate a corrupted/undersized reservation (e.g. a hypothetical
      // bug elsewhere) — the fill would require consuming 5 (10*0.5), but
      // only 1 is left available.
      const buyerReservation = await prisma.fundReservation.findFirstOrThrow({ where: { referenceType: "Order", referenceId: buyOrder.id } });
      await prisma.fundReservation.update({ where: { id: buyerReservation.id }, data: { amount: "1" } });

      await expect(executionCoordinator.matchAndExecute(sellOrder.id)).rejects.toThrow(/unconsumed/);

      // The whole execution transaction rolled back — no Fill, no partial
      // consumption, no order-state change of any kind.
      expect(await fillsFor(buyOrder.id)).toHaveLength(0);
      const finalBuy = await prisma.order.findUniqueOrThrow({ where: { id: buyOrder.id } });
      expect(finalBuy.status).toBe("OPEN");
      expect(finalBuy.remainingQuantity.toString()).toBe("10");
    });
  });

  // OrdersService.create's post-funding matchAndExecute call used to catch
  // and merely log a matching-layer exception, returning as if placement
  // had fully succeeded. That silently hid the fact that an immediately-
  // crossable counterparty may have been missed. These tests exercise the
  // fix: create() now throws MatchingAttemptFailedException instead, and
  // OrdersService.retryMatching is the explicit, idempotency-safe recovery
  // path. Each test builds its own OrdersService instance wired to the
  // SAME real reservation/ledger/txRunner dependencies as `ordersService`,
  // but with a controllable ExecutionCoordinator double standing in for
  // the matching layer — so the funding path is 100% real Postgres
  // behavior, and only the matching-layer failure is simulated.
  describe("post-funding matching failure handling (financial safety)", () => {
    function buildOrdersService(matchAndExecute: jest.Mock) {
      return new OrdersService(
        prisma,
        reservations,
        positionReservations,
        orderRiskValidator,
        feeCalculator,
        txRunner,
        { matchAndExecute } as unknown as ExecutionCoordinator,
      );
    }

    it("order placement + matching success: an ordinary crossing order still resolves normally end-to-end", async () => {
      const { market, yes } = await setup();
      const buyer = await createTestUser();
      const seller = await createTestUser();
      await fundUserForTest(buyer.id, "USDC", "100");
      await grantPositionForTest(seller.id, market.id, yes.id, "10");
      await sell(seller.id, market.id, yes.id, "10", "0.5");

      const workingOrdersService = buildOrdersService(jest.fn((orderId: string) => executionCoordinator.matchAndExecute(orderId)));
      const dto = { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5" } as never;

      await expect(workingOrdersService.create(buyer.id, dto)).resolves.toMatchObject({ status: "FILLED" });
      expect(await fillsFor((await prisma.order.findFirstOrThrow({ where: { userId: buyer.id, marketId: market.id } })).id)).toHaveLength(1);
    });

    it("matching failure after funding: throws MatchingAttemptFailedException instead of a silent success, and fabricates no fill", async () => {
      const { market, yes } = await setup();
      const buyer = await createTestUser();
      const seller = await createTestUser();
      await fundUserForTest(buyer.id, "USDC", "100");
      await grantPositionForTest(seller.id, market.id, yes.id, "10");
      await sell(seller.id, market.id, yes.id, "10", "0.5"); // a real, crossable counterparty already rests

      const failingOrdersService = buildOrdersService(jest.fn().mockRejectedValue(new Error("simulated matching-layer failure")));
      const dto = { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5" } as never;

      await expect(failingOrdersService.create(buyer.id, dto)).rejects.toThrow(MatchingAttemptFailedException);

      const buyOrder = await prisma.order.findFirstOrThrow({ where: { userId: buyer.id, marketId: market.id } });
      expect(await fillsFor(buyOrder.id)).toHaveLength(0); // no fabricated fill despite a crossable counterparty existing
    });

    it("reservation remains correct after a matching failure: the order stays OPEN, fully reserved, funds untouched — nothing stranded", async () => {
      const { market, yes } = await setup();
      const buyer = await createTestUser();
      const seller = await createTestUser();
      await fundUserForTest(buyer.id, "USDC", "100");
      await grantPositionForTest(seller.id, market.id, yes.id, "10");
      await sell(seller.id, market.id, yes.id, "10", "0.5");

      const failingOrdersService = buildOrdersService(jest.fn().mockRejectedValue(new Error("simulated matching-layer failure")));
      const dto = { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5" } as never;
      await expect(failingOrdersService.create(buyer.id, dto)).rejects.toThrow(MatchingAttemptFailedException);

      const buyOrder = await prisma.order.findFirstOrThrow({ where: { userId: buyer.id, marketId: market.id } });
      expect(buyOrder.status).toBe("OPEN"); // the funding transaction committed independently of the failed match attempt
      expect(buyOrder.remainingQuantity.toString()).toBe("10");

      const reservation = await reservations.findActiveByReference(prisma, "Order", buyOrder.id);
      expect(reservation).not.toBeNull();
      expect(reservation!.consumedAmount.toString()).toBe("0"); // nothing consumed

      const buyerAccount = await getUserAccount(buyer.id, "USDC");
      expect(buyerAccount?.reservedBalance.toString()).toBe("5"); // 10 * 0.5, still fully earmarked
      expect(buyerAccount?.cachedBalance.toString()).toBe("100"); // no premature debit
    });

    it("retry/recovery: OrdersService.retryMatching after a failure successfully matches against the still-resting counterparty", async () => {
      const { market, yes } = await setup();
      const buyer = await createTestUser();
      const seller = await createTestUser();
      await fundUserForTest(buyer.id, "USDC", "100");
      await grantPositionForTest(seller.id, market.id, yes.id, "10");
      await sell(seller.id, market.id, yes.id, "10", "0.5");

      const flakyMatchAndExecute = jest
        .fn()
        .mockRejectedValueOnce(new Error("simulated transient failure"))
        .mockImplementation((orderId: string) => executionCoordinator.matchAndExecute(orderId));
      const flakyOrdersService = buildOrdersService(flakyMatchAndExecute);
      const dto = { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5" } as never;

      await expect(flakyOrdersService.create(buyer.id, dto)).rejects.toThrow(MatchingAttemptFailedException);
      const buyOrder = await prisma.order.findFirstOrThrow({ where: { userId: buyer.id, marketId: market.id } });
      expect(buyOrder.status).toBe("OPEN"); // confirmed unmatched after the failure

      const summary = await flakyOrdersService.retryMatching(buyer.id, buyOrder.id);
      expect(summary.status).toBe("FILLED");
      expect(summary.fills).toHaveLength(1);

      const fills = await fillsFor(buyOrder.id);
      expect(fills).toHaveLength(1);
      expect(fills[0].quantity.toString()).toBe("10");
      const buyerAccount = await getUserAccount(buyer.id, "USDC");
      expect(buyerAccount?.reservedBalance.toString()).toBe("0"); // consumed exactly once
    });

    it("no duplicate fill/execution on retry: calling retryMatching again after a successful recovery changes nothing", async () => {
      const { market, yes } = await setup();
      const buyer = await createTestUser();
      const seller = await createTestUser();
      await fundUserForTest(buyer.id, "USDC", "100");
      await grantPositionForTest(seller.id, market.id, yes.id, "10");
      await sell(seller.id, market.id, yes.id, "10", "0.5");

      const flakyMatchAndExecute = jest
        .fn()
        .mockRejectedValueOnce(new Error("simulated transient failure"))
        .mockImplementation((orderId: string) => executionCoordinator.matchAndExecute(orderId));
      const flakyOrdersService = buildOrdersService(flakyMatchAndExecute);
      const dto = { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.5" } as never;

      await expect(flakyOrdersService.create(buyer.id, dto)).rejects.toThrow(MatchingAttemptFailedException);
      const buyOrder = await prisma.order.findFirstOrThrow({ where: { userId: buyer.id, marketId: market.id } });

      await flakyOrdersService.retryMatching(buyer.id, buyOrder.id); // recovers, fills once
      const secondSummary = await flakyOrdersService.retryMatching(buyer.id, buyOrder.id); // now FILLED — a safe no-op

      expect(secondSummary.fills).toHaveLength(1); // unchanged — no duplicate fill
      const fills = await fillsFor(buyOrder.id);
      expect(fills).toHaveLength(1);
      const buyerAccount = await getUserAccount(buyer.id, "USDC");
      expect(buyerAccount?.reservedBalance.toString()).toBe("0"); // consumed exactly once, not twice
      const sellerAccount = await getUserAccount(seller.id, "USDC");
      expect(sellerAccount?.cachedBalance.toString()).toBe("5"); // credited exactly once, not twice
    });
  });
});
