import { BadRequestException, ConflictException } from "@nestjs/common";
import { createTestMarket, createTestUser, marketsService, openMarketForTest, ordersService } from "./helpers";

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
