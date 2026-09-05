import { InsufficientBalanceError } from "../../src/ledger/ledger.errors";
import { InsufficientPositionError } from "../../src/trading/trading.errors";
import {
  createTestMarket,
  createTestUser,
  fundUserForTest,
  getUserAccount,
  grantPositionForTest,
  openMarketForTest,
  orderBookService,
  ordersService,
  prisma,
} from "./helpers";

async function openTestMarket(adminId: string) {
  const built = await createTestMarket(adminId);
  await openMarketForTest(built.market.id, adminId);
  return built;
}

describe("Order funding (real Postgres)", () => {
  describe("BUY — cash reservation", () => {
    it("reserves exactly quantity*price and leaves total balance untouched", async () => {
      const admin = await createTestUser();
      const trader = await createTestUser();
      const { market, yes } = await openTestMarket(admin.id);
      await fundUserForTest(trader.id, "USDC", "1000");

      const order = await ordersService.create(trader.id, {
        marketId: market.id,
        outcomeId: yes.id,
        side: "BUY",
        type: "LIMIT",
        quantity: "40",
        price: "0.25",
      } as never);

      expect(order.status).toBe("OPEN");
      expect(order.remainingQuantity.toString()).toBe("40");

      const account = await getUserAccount(trader.id, "USDC");
      expect(account?.cachedBalance.toString()).toBe("1000"); // untouched — nothing left the system
      expect(account?.reservedBalance.toString()).toBe("10"); // 40 * 0.25
    });

    it("rejects a BUY order that exceeds available balance", async () => {
      const admin = await createTestUser();
      const trader = await createTestUser();
      const { market, yes } = await openTestMarket(admin.id);
      await fundUserForTest(trader.id, "USDC", "5");

      await expect(
        ordersService.create(trader.id, {
          marketId: market.id,
          outcomeId: yes.id,
          side: "BUY",
          type: "LIMIT",
          quantity: "40",
          price: "0.25", // costs 10, only 5 available
        } as never),
      ).rejects.toThrow(InsufficientBalanceError);

      const account = await getUserAccount(trader.id, "USDC");
      expect(account?.reservedBalance.toString()).toBe("0"); // nothing left reserved
      const orders = await prisma.order.findMany({ where: { userId: trader.id } });
      expect(orders).toHaveLength(0); // and no order was left behind either
    });

    it("a second reservation cannot exceed what's left available after the first", async () => {
      const admin = await createTestUser();
      const trader = await createTestUser();
      const { market, yes } = await openTestMarket(admin.id);
      await fundUserForTest(trader.id, "USDC", "10");

      await ordersService.create(trader.id, {
        marketId: market.id,
        outcomeId: yes.id,
        side: "BUY",
        type: "LIMIT",
        quantity: "20",
        price: "0.4", // costs 8
      } as never);

      await expect(
        ordersService.create(trader.id, {
          marketId: market.id,
          outcomeId: yes.id,
          side: "BUY",
          type: "LIMIT",
          quantity: "20",
          price: "0.4", // would cost another 8, only 2 left available
        } as never),
      ).rejects.toThrow(InsufficientBalanceError);
    });

    it("cancellation releases the reservation and restores available balance", async () => {
      const admin = await createTestUser();
      const trader = await createTestUser();
      const { market, yes } = await openTestMarket(admin.id);
      await fundUserForTest(trader.id, "USDC", "100");

      const order = await ordersService.create(trader.id, {
        marketId: market.id,
        outcomeId: yes.id,
        side: "BUY",
        type: "LIMIT",
        quantity: "40",
        price: "0.25",
      } as never);

      await ordersService.cancel(trader.id, order.id);

      const account = await getUserAccount(trader.id, "USDC");
      expect(account?.cachedBalance.toString()).toBe("100");
      expect(account?.reservedBalance.toString()).toBe("0");
    });

    it("concurrent BUY orders cannot overspend the same available balance", async () => {
      const admin = await createTestUser();
      const trader = await createTestUser();
      const { market, yes } = await openTestMarket(admin.id);
      await fundUserForTest(trader.id, "USDC", "100");

      // 15 concurrent orders each costing 10 (quantity 20 * price 0.5)
      // against a balance of 100 — at most 10 can succeed.
      const results = await Promise.allSettled(
        Array.from({ length: 15 }, () =>
          ordersService.create(trader.id, {
            marketId: market.id,
            outcomeId: yes.id,
            side: "BUY",
            type: "LIMIT",
            quantity: "20",
            price: "0.5",
            clientOrderId: `concurrent-buy-${Math.random()}`,
          } as never),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(10);
      expect(rejected).toHaveLength(5);
      for (const r of rejected as PromiseRejectedResult[]) {
        expect(r.reason).toBeInstanceOf(InsufficientBalanceError);
      }

      const account = await getUserAccount(trader.id, "USDC");
      expect(account?.reservedBalance.toString()).toBe("100"); // exactly drained, never over
      expect(account?.cachedBalance.toString()).toBe("100");
    });
  });

  describe("SELL — outcome-share reservation", () => {
    it("reserves outcome shares and rejects a SELL exceeding held quantity", async () => {
      const admin = await createTestUser();
      const trader = await createTestUser();
      const { market, yes } = await openTestMarket(admin.id);

      await expect(
        ordersService.create(trader.id, {
          marketId: market.id,
          outcomeId: yes.id,
          side: "SELL",
          type: "LIMIT",
          quantity: "10",
          price: "0.5",
        } as never),
      ).rejects.toThrow(InsufficientPositionError); // no position exists yet — never fabricated
    });

    it("a funded position allows a SELL up to (and not beyond) its quantity", async () => {
      const admin = await createTestUser();
      const trader = await createTestUser();
      const { market, yes } = await openTestMarket(admin.id);
      await grantPositionForTest(trader.id, market.id, yes.id, "50");

      const order = await ordersService.create(trader.id, {
        marketId: market.id,
        outcomeId: yes.id,
        side: "SELL",
        type: "LIMIT",
        quantity: "50",
        price: "0.6",
      } as never);
      expect(order.status).toBe("OPEN");

      await expect(
        ordersService.create(trader.id, {
          marketId: market.id,
          outcomeId: yes.id,
          side: "SELL",
          type: "LIMIT",
          quantity: "1",
          price: "0.6",
        } as never),
      ).rejects.toThrow(InsufficientPositionError); // all 50 shares already reserved
    });

    it("cancelling a SELL releases the reserved shares", async () => {
      const admin = await createTestUser();
      const trader = await createTestUser();
      const { market, yes } = await openTestMarket(admin.id);
      await grantPositionForTest(trader.id, market.id, yes.id, "20");

      const order = await ordersService.create(trader.id, {
        marketId: market.id,
        outcomeId: yes.id,
        side: "SELL",
        type: "LIMIT",
        quantity: "20",
        price: "0.5",
      } as never);
      await ordersService.cancel(trader.id, order.id);

      const position = await prisma.position.findUniqueOrThrow({
        where: { userId_marketId_outcomeId: { userId: trader.id, marketId: market.id, outcomeId: yes.id } },
      });
      expect(position.quantity.toString()).toBe("20"); // shares never left the holder
      expect(position.reservedQuantity.toString()).toBe("0");
    });

    it("concurrent SELL orders cannot reserve more shares than are held", async () => {
      const admin = await createTestUser();
      const trader = await createTestUser();
      const { market, yes } = await openTestMarket(admin.id);
      await grantPositionForTest(trader.id, market.id, yes.id, "100");

      // 15 concurrent SELLs of 20 shares each against 100 held — at most 5 succeed.
      const results = await Promise.allSettled(
        Array.from({ length: 15 }, () =>
          ordersService.create(trader.id, {
            marketId: market.id,
            outcomeId: yes.id,
            side: "SELL",
            type: "LIMIT",
            quantity: "20",
            price: "0.5",
            clientOrderId: `concurrent-sell-${Math.random()}`,
          } as never),
        ),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(5);
      expect(rejected).toHaveLength(10);

      const position = await prisma.position.findUniqueOrThrow({
        where: { userId_marketId_outcomeId: { userId: trader.id, marketId: market.id, outcomeId: yes.id } },
      });
      expect(position.reservedQuantity.toString()).toBe("100"); // exactly drained, never over
    });
  });

  describe("order book reflects real persisted orders", () => {
    it("aggregates bids/asks correctly from concurrently-placed orders", async () => {
      const admin = await createTestUser();
      const { market, yes } = await openTestMarket(admin.id);
      const buyers = await Promise.all([createTestUser(), createTestUser()]);
      const seller = await createTestUser();
      await Promise.all(buyers.map((b) => fundUserForTest(b.id, "USDC", "100")));
      await grantPositionForTest(seller.id, market.id, yes.id, "50");

      await Promise.all([
        ordersService.create(buyers[0].id, { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.3" } as never),
        ordersService.create(buyers[1].id, { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", quantity: "10", price: "0.3" } as never),
        ordersService.create(seller.id, { marketId: market.id, outcomeId: yes.id, side: "SELL", type: "LIMIT", quantity: "15", price: "0.7" } as never),
      ]);

      const book = await orderBookService.getBook(market.id, yes.id);
      expect(book.bids).toEqual([{ price: "0.3", remainingQuantity: "20" }]); // two buyers aggregated
      expect(book.asks).toEqual([{ price: "0.7", remainingQuantity: "15" }]);
    });
  });
});
