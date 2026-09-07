import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  createTestMarket,
  createTestUser,
  fundUserForTest,
  getUserAccount,
  grantPositionForTest,
  marketsService,
  openMarketForTest,
  ordersService,
  positionReservations,
  prisma,
  reservations,
} from "./helpers";

describe("Market lifecycle (real Postgres)", () => {
  it("creates a DRAFT market with outcomes belonging to it", async () => {
    const admin = await createTestUser();
    const { market, yes, no } = await createTestMarket(admin.id);

    expect(market.status).toBe("DRAFT");
    expect(yes.marketId).toBe(market.id);
    expect(no.marketId).toBe(market.id);
    expect(yes.key).toBe("YES");
    expect(no.key).toBe("NO");
  });

  it("opens a DRAFT market", async () => {
    const admin = await createTestUser();
    const { market } = await createTestMarket(admin.id);

    const opened = await openMarketForTest(market.id, admin.id);
    expect(opened.status).toBe("OPEN");
  });

  it("rejects opening a market that is not DRAFT", async () => {
    const admin = await createTestUser();
    const { market } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);

    await expect(openMarketForTest(market.id, admin.id)).rejects.toThrow(ConflictException);
  });

  it("closes an OPEN market", async () => {
    const admin = await createTestUser();
    const { market } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);

    const closed = await marketsService.close(market.id, admin.id);
    expect(closed.status).toBe("CLOSED");
  });

  it("rejects trading on a market that has never been opened (DRAFT)", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);

    await expect(
      ordersService.create(trader.id, {
        marketId: market.id,
        outcomeId: yes.id,
        side: "BUY",
        type: "LIMIT",
        quantity: "10",
        price: "0.5",
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects trading on a CLOSED market", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await marketsService.close(market.id, admin.id);

    await expect(
      ordersService.create(trader.id, {
        marketId: market.id,
        outcomeId: yes.id,
        side: "BUY",
        type: "LIMIT",
        quantity: "10",
        price: "0.5",
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an order whose outcome belongs to a different market", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market: marketA } = await createTestMarket(admin.id);
    const { market: marketB, yes: yesB } = await createTestMarket(admin.id);
    await openMarketForTest(marketA.id, admin.id);
    await openMarketForTest(marketB.id, admin.id);

    await expect(
      ordersService.create(trader.id, {
        marketId: marketA.id, // mismatched: outcome belongs to marketB
        outcomeId: yesB.id,
        side: "BUY",
        type: "LIMIT",
        quantity: "10",
        price: "0.5",
      } as never),
    ).rejects.toThrow(BadRequestException);
  });

  it("closing a market expires every resting order (both sides) and releases each one's reservation", async () => {
    const admin = await createTestUser();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "10");

    // Two resting orders that do NOT cross each other (different prices),
    // so both remain OPEN with active reservations right up to close().
    const buyOrder = await ordersService.create(buyer.id, {
      marketId: market.id,
      outcomeId: yes.id,
      side: "BUY",
      type: "LIMIT",
      quantity: "10",
      price: "0.4",
    } as never);
    const sellOrder = await ordersService.create(seller.id, {
      marketId: market.id,
      outcomeId: yes.id,
      side: "SELL",
      type: "LIMIT",
      quantity: "10",
      price: "0.6",
    } as never);

    await marketsService.close(market.id, admin.id);

    const finalBuy = await prisma.order.findUniqueOrThrow({ where: { id: buyOrder.id } });
    const finalSell = await prisma.order.findUniqueOrThrow({ where: { id: sellOrder.id } });
    expect(finalBuy.status).toBe("EXPIRED"); // system-driven termination, not CANCELLED
    expect(finalSell.status).toBe("EXPIRED");

    expect(await reservations.findActiveByReference(prisma, "Order", buyOrder.id)).toBeNull();
    expect(await positionReservations.findActiveByReference(prisma, "Order", sellOrder.id)).toBeNull();

    const buyerAccount = await getUserAccount(buyer.id, "USDC");
    expect(buyerAccount?.reservedBalance.toString()).toBe("0"); // released, not stranded
    expect(buyerAccount?.cachedBalance.toString()).toBe("100"); // untouched

    const sellerPosition = await prisma.position.findUniqueOrThrow({
      where: { userId_marketId_outcomeId: { userId: seller.id, marketId: market.id, outcomeId: yes.id } },
    });
    expect(sellerPosition.reservedQuantity.toString()).toBe("0"); // released, not stranded
    expect(sellerPosition.quantity.toString()).toBe("10"); // shares themselves untouched
  });

  it("a partially-filled order is also expired (not just fully-open ones) when its market closes", async () => {
    const admin = await createTestUser();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await fundUserForTest(buyer.id, "USDC", "100");
    await grantPositionForTest(seller.id, market.id, yes.id, "10");

    // buyer's order for 10 partially fills against a smaller resting sell.
    const buyOrder = await ordersService.create(buyer.id, {
      marketId: market.id,
      outcomeId: yes.id,
      side: "BUY",
      type: "LIMIT",
      quantity: "10",
      price: "0.5",
    } as never);
    await ordersService.create(seller.id, {
      marketId: market.id,
      outcomeId: yes.id,
      side: "SELL",
      type: "LIMIT",
      quantity: "4",
      price: "0.5",
    } as never);

    const midway = await prisma.order.findUniqueOrThrow({ where: { id: buyOrder.id } });
    expect(midway.status).toBe("PARTIALLY_FILLED");

    await marketsService.close(market.id, admin.id);

    const finalBuy = await prisma.order.findUniqueOrThrow({ where: { id: buyOrder.id } });
    expect(finalBuy.status).toBe("EXPIRED");
    expect(finalBuy.remainingQuantity.toString()).toBe("6"); // the already-filled 4 is untouched history

    const buyerAccount = await getUserAccount(buyer.id, "USDC");
    expect(buyerAccount?.reservedBalance.toString()).toBe("0"); // remaining earmark released
  });

  it(
    "resolve vs order submission: an order submitted concurrently with market close never survives as a resting order on a CLOSED market " +
      "(race: OrdersService.create()'s pre-transaction market-status read can go stale if MarketsService.close() commits between that " +
      "read and the funding transaction; invariant: the funding transaction re-validates market status under SERIALIZABLE, so either " +
      "the order is rejected as CLOSED, or it was created and expired by close() itself — never left OPEN/PARTIALLY_FILLED on a market " +
      "that is no longer OPEN, which would otherwise strand a reservation and block ResolutionService's own defensive resting-order check)",
    async () => {
      const admin = await createTestUser();
      const trader = await createTestUser();
      const { market, yes } = await createTestMarket(admin.id);
      await openMarketForTest(market.id, admin.id);
      await fundUserForTest(trader.id, "USDC", "100");

      const results = await Promise.allSettled([
        ordersService.create(trader.id, {
          marketId: market.id,
          outcomeId: yes.id,
          side: "BUY",
          type: "LIMIT",
          quantity: "10",
          price: "0.5",
        } as never),
        marketsService.close(market.id, admin.id),
      ]);

      expect(results[1].status).toBe("fulfilled"); // close() itself always succeeds

      const finalMarket = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
      expect(finalMarket.status).toBe("CLOSED");

      const restingOrders = await prisma.order.count({
        where: { marketId: market.id, status: { in: ["OPEN", "PARTIALLY_FILLED"] } },
      });
      expect(restingOrders).toBe(0); // the invariant that actually matters: nothing survives resting past close, whichever way the race fell

      if (results[0].status === "fulfilled") {
        // The order won the race and was created before close() committed —
        // close()'s own resting-order expiry must have caught it.
        const order = results[0].value as { id: string };
        const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
        expect(finalOrder.status).toBe("EXPIRED");
        const account = await getUserAccount(trader.id, "USDC");
        expect(account?.reservedBalance.toString()).toBe("0"); // released, not stranded
      }
    },
  );

  it("rejects trading on a market past its configured closeTime, even if status is still OPEN", async () => {
    const admin = await createTestUser();
    const trader = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id, { closeTime: new Date(Date.now() - 60_000).toISOString() });
    await openMarketForTest(market.id, admin.id);

    await expect(
      ordersService.create(trader.id, {
        marketId: market.id,
        outcomeId: yes.id,
        side: "BUY",
        type: "LIMIT",
        quantity: "10",
        price: "0.5",
      } as never),
    ).rejects.toThrow(BadRequestException);
  });
});
