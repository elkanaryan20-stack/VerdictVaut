import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import {
  createTestAdmin,
  createTestMarket,
  createTestUser,
  fundUserForTest,
  getUserAccount,
  grantPositionForTest,
  marketsService,
  openMarketForTest,
  prisma,
  resolutionService,
  settlementService,
  txRunner,
} from "./helpers";

async function setupClosedMarket(overrides: { closeTime?: string } = {}) {
  const admin = await createTestAdmin();
  const { market, yes, no } = await createTestMarket(admin.id, overrides);
  await openMarketForTest(market.id, admin.id);
  await marketsService.close(market.id, admin.id);
  return { admin, market, yes, no };
}

/**
 * Mirrors ResolutionService.resolve()'s own transaction body exactly,
 * minus the synchronous auto-settle call — so tests can construct a
 * RESOLVING market with real, still-unsettled positions and race
 * settleMarket() against it deliberately, the same way Phase 3's
 * placeRestingOrderNoAutoMatch bypasses OrdersService.create's
 * auto-match to construct matching races on purpose.
 */
async function resolveWithoutAutoSettle(marketId: string, winningOutcomeId: string, resolverId: string) {
  return txRunner.run(async (tx) => {
    const market = await tx.market.findUniqueOrThrow({ where: { id: marketId }, include: { outcomes: true } });
    await tx.market.updateMany({ where: { id: marketId, status: "CLOSED" }, data: { status: "RESOLVING" } });
    await tx.marketResolution.create({ data: { marketId, winningOutcomeId, resolverId } });
    await tx.settlement.createMany({
      data: market.outcomes.map((o) => ({
        marketId,
        outcomeId: o.id,
        payoutPerShare: o.id === winningOutcomeId ? "1" : "0",
        status: "COMPLETED",
        processedAt: new Date(),
      })),
    });
  });
}

describe("Market resolution & settlement (real Postgres)", () => {
  describe("resolution", () => {
    it("valid resolution: records the MarketResolution, a per-outcome Settlement rate, and reaches RESOLVED when there is nothing to settle", async () => {
      const { admin, market, yes, no } = await setupClosedMarket();

      const resolved = await resolutionService.resolve(market.id, admin.id, yes.id, "per official statement");
      expect(resolved.status).toBe("RESOLVED");

      const status = await resolutionService.getResolutionStatus(market.id);
      expect(status.resolution?.winningOutcomeId).toBe(yes.id);
      expect(status.resolution?.resolverId).toBe(admin.id);
      expect(status.resolution?.notes).toBe("per official statement");
      expect(status.resolution?.resolvedAt).toBeDefined();
      expect(status.resolution?.settledAt).not.toBeNull();
      expect(status.settlement).toEqual({ settledPositions: 0, totalPositions: 0 });

      const rates = await prisma.settlement.findMany({ where: { marketId: market.id } });
      expect(rates.find((r) => r.outcomeId === yes.id)?.payoutPerShare.toString()).toBe("1");
      expect(rates.find((r) => r.outcomeId === no.id)?.payoutPerShare.toString()).toBe("0");
    });

    it("rejects an invalid outcome id", async () => {
      const { admin, market } = await setupClosedMarket();
      await expect(resolutionService.resolve(market.id, admin.id, "not-a-real-outcome-id")).rejects.toThrow(BadRequestException);

      const finalMarket = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
      expect(finalMarket.status).toBe("CLOSED"); // untouched — never partially transitioned
    });

    it("rejects resolution by an unauthorized (non-admin) user", async () => {
      const { market, yes } = await setupClosedMarket();
      const trader = await createTestUser();

      await expect(resolutionService.resolve(market.id, trader.id, yes.id)).rejects.toThrow(ForbiddenException);
      const finalMarket = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
      expect(finalMarket.status).toBe("CLOSED");
    });

    it("rejects resolving a market that was never closed (still OPEN)", async () => {
      const admin = await createTestAdmin();
      const { market, yes } = await createTestMarket(admin.id);
      await openMarketForTest(market.id, admin.id);

      await expect(resolutionService.resolve(market.id, admin.id, yes.id)).rejects.toThrow(ConflictException);
    });

    it("rejects resolving a market twice", async () => {
      const { admin, market, yes, no } = await setupClosedMarket();
      await resolutionService.resolve(market.id, admin.id, yes.id);

      await expect(resolutionService.resolve(market.id, admin.id, no.id)).rejects.toThrow(ConflictException);

      const resolutions = await prisma.marketResolution.findMany({ where: { marketId: market.id } });
      expect(resolutions).toHaveLength(1);
      expect(resolutions[0].winningOutcomeId).toBe(yes.id); // the second attempt never overwrote the first
    });

    it("two concurrent resolution attempts on the same market: exactly one wins, the other is rejected, never both", async () => {
      const { admin, market, yes } = await setupClosedMarket();

      const results = await Promise.allSettled([
        resolutionService.resolve(market.id, admin.id, yes.id),
        resolutionService.resolve(market.id, admin.id, yes.id),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

      const resolutions = await prisma.marketResolution.findMany({ where: { marketId: market.id } });
      expect(resolutions).toHaveLength(1);
    });
  });

  describe("settlement payouts", () => {
    it("complete flow: a winning position is credited through the authoritative ledger; a losing position's balance is untouched", async () => {
      const { admin, market, yes, no } = await setupClosedMarket();
      const winner = await createTestUser();
      const loser = await createTestUser();
      await fundUserForTest(winner.id, "USDC", "0");
      await fundUserForTest(loser.id, "USDC", "50");
      await grantPositionForTest(winner.id, market.id, yes.id, "10");
      await grantPositionForTest(loser.id, market.id, no.id, "20");

      await resolutionService.resolve(market.id, admin.id, yes.id);

      const winnerAccount = await getUserAccount(winner.id, "USDC");
      expect(winnerAccount?.cachedBalance.toString()).toBe("10"); // 10 shares * payoutPerShare 1

      const loserAccount = await getUserAccount(loser.id, "USDC");
      expect(loserAccount?.cachedBalance.toString()).toBe("50"); // exactly what they were funded with — zero payout, not a debit

      const winnerPosition = await prisma.position.findUniqueOrThrow({
        where: { userId_marketId_outcomeId: { userId: winner.id, marketId: market.id, outcomeId: yes.id } },
      });
      const loserPosition = await prisma.position.findUniqueOrThrow({
        where: { userId_marketId_outcomeId: { userId: loser.id, marketId: market.id, outcomeId: no.id } },
      });
      expect(winnerPosition.settledAt).not.toBeNull();
      expect(loserPosition.settledAt).not.toBeNull();

      const winnerSettlement = await prisma.positionSettlement.findUniqueOrThrow({ where: { positionId: winnerPosition.id } });
      expect(winnerSettlement.quantity.toString()).toBe("10");
      expect(winnerSettlement.payoutPerShare.toString()).toBe("1");
      expect(winnerSettlement.payoutAmount.toString()).toBe("10");
      expect(winnerSettlement.ledgerTransactionId).not.toBeNull();

      const loserSettlement = await prisma.positionSettlement.findUniqueOrThrow({ where: { positionId: loserPosition.id } });
      expect(loserSettlement.payoutAmount.toString()).toBe("0");
      expect(loserSettlement.ledgerTransactionId).toBeNull(); // no cash moved, no ledger entry posted
    });

    it("ledger: the SETTLEMENT_POOL house account is debited exactly the sum of every winning payout", async () => {
      const { admin, market, yes } = await setupClosedMarket();
      const winnerA = await createTestUser();
      const winnerB = await createTestUser();
      await grantPositionForTest(winnerA.id, market.id, yes.id, "10");
      await grantPositionForTest(winnerB.id, market.id, yes.id, "25");

      // SETTLEMENT_POOL is a single shared house account (one per asset,
      // not per market/test) — other tests in this same run also debit
      // it, so only the DELTA this resolution causes is meaningful, not
      // an absolute balance.
      const asset = await prisma.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } });
      const before = await prisma.ledgerAccount.upsert({
        where: { houseAccountKey_assetId: { houseAccountKey: "SETTLEMENT_POOL", assetId: asset.id } },
        create: { ownerType: "HOUSE", houseAccountKey: "SETTLEMENT_POOL", assetId: asset.id, cachedBalance: 0, reservedBalance: 0 },
        update: {},
      });

      await resolutionService.resolve(market.id, admin.id, yes.id);

      const after = await prisma.ledgerAccount.findUniqueOrThrow({
        where: { houseAccountKey_assetId: { houseAccountKey: "SETTLEMENT_POOL", assetId: asset.id } },
      });
      const delta = after.cachedBalance.minus(before.cachedBalance);
      expect(delta.toString()).toBe("-35"); // 10 + 25, negative — funds winners, never collateralized
    });

    it("multiple positions across multiple users for the same market settle independently and correctly", async () => {
      const { admin, market, yes, no } = await setupClosedMarket();
      const users = await Promise.all(Array.from({ length: 4 }, () => createTestUser()));
      await grantPositionForTest(users[0].id, market.id, yes.id, "3");
      await grantPositionForTest(users[1].id, market.id, yes.id, "8");
      await grantPositionForTest(users[2].id, market.id, no.id, "5");
      await grantPositionForTest(users[3].id, market.id, no.id, "12");

      await resolutionService.resolve(market.id, admin.id, yes.id);

      expect((await getUserAccount(users[0].id, "USDC"))?.cachedBalance.toString()).toBe("3");
      expect((await getUserAccount(users[1].id, "USDC"))?.cachedBalance.toString()).toBe("8");
      expect(await getUserAccount(users[2].id, "USDC")).toBeNull(); // no payout, never funded — no account ever created
      expect(await getUserAccount(users[3].id, "USDC")).toBeNull();

      const settledCount = await prisma.position.count({ where: { marketId: market.id, settledAt: { not: null } } });
      expect(settledCount).toBe(4);
    });

    it("decimal precision: a fractional quantity settles exactly, with no floating-point drift", async () => {
      const { admin, market, yes } = await setupClosedMarket();
      const winner = await createTestUser();
      await grantPositionForTest(winner.id, market.id, yes.id, "10.123456789012345678");

      await resolutionService.resolve(market.id, admin.id, yes.id);

      const account = await getUserAccount(winner.id, "USDC");
      expect(account?.cachedBalance.toString()).toBe("10.123456789012345678");
    });

    it("a zero-quantity position is still marked settled, with zero payout and no ledger entry", async () => {
      const { admin, market, yes } = await setupClosedMarket();
      const flatUser = await createTestUser();
      await grantPositionForTest(flatUser.id, market.id, yes.id, "0");

      await resolutionService.resolve(market.id, admin.id, yes.id);

      const position = await prisma.position.findUniqueOrThrow({
        where: { userId_marketId_outcomeId: { userId: flatUser.id, marketId: market.id, outcomeId: yes.id } },
      });
      expect(position.settledAt).not.toBeNull();
      const settlement = await prisma.positionSettlement.findUniqueOrThrow({ where: { positionId: position.id } });
      expect(settlement.payoutAmount.toString()).toBe("0");
      expect(settlement.ledgerTransactionId).toBeNull();
    });

    it("duplicate settlement: calling settleMarket again once a market is already RESOLVED is a safe no-op — no double credit", async () => {
      const { admin, market, yes } = await setupClosedMarket();
      const winner = await createTestUser();
      await grantPositionForTest(winner.id, market.id, yes.id, "10");
      await resolutionService.resolve(market.id, admin.id, yes.id);

      const result = await settlementService.settleMarket(market.id);
      expect(result).toEqual({ settledCount: 0, remaining: 0, resolved: true });

      const account = await getUserAccount(winner.id, "USDC");
      expect(account?.cachedBalance.toString()).toBe("10"); // unchanged — not 20
      expect(await prisma.positionSettlement.count({ where: { marketId: market.id } })).toBe(1);
    });

    it(
      "concurrent settlement: several simultaneous settleMarket calls against the same still-RESOLVING market settle every " +
        "position exactly once (this is also the stale-instruction case: each per-position transaction re-fetches its " +
        "own position fresh and skips it if a concurrent call already settled it, rather than trusting the initial scan)",
      async () => {
        const { admin, market, yes } = await setupClosedMarket();
        const winners = await Promise.all(Array.from({ length: 6 }, () => createTestUser()));
        await Promise.all(winners.map((w) => grantPositionForTest(w.id, market.id, yes.id, "10")));

        await resolveWithoutAutoSettle(market.id, yes.id, admin.id);

        const results = await Promise.allSettled([
          settlementService.settleMarket(market.id),
          settlementService.settleMarket(market.id),
          settlementService.settleMarket(market.id),
        ]);
        expect(results.every((r) => r.status === "fulfilled")).toBe(true);

        for (const w of winners) {
          const account = await getUserAccount(w.id, "USDC");
          expect(account?.cachedBalance.toString()).toBe("10"); // credited exactly once, never twice
        }
        expect(await prisma.positionSettlement.count({ where: { marketId: market.id } })).toBe(winners.length);

        const finalMarket = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
        expect(finalMarket.status).toBe("RESOLVED"); // exactly one of the racers won the final CAS
      },
    );

    it(
      "rollback on failure + retry: a corrupted position's settlement fails loudly without affecting other positions, " +
        "and a retry after the fix completes the market with no duplicate payouts for whichever positions already succeeded",
      async () => {
        const { admin, market, yes } = await setupClosedMarket();
        const good1 = await createTestUser();
        const bad = await createTestUser();
        const good2 = await createTestUser();
        await grantPositionForTest(good1.id, market.id, yes.id, "10");
        await grantPositionForTest(bad.id, market.id, yes.id, "5");
        await grantPositionForTest(good2.id, market.id, yes.id, "7");

        // Simulate a corrupted position (e.g. a hypothetical bug
        // elsewhere left a reservation active) — settlement must refuse
        // to proceed past this structural invariant rather than silently
        // ignoring it.
        await prisma.position.update({
          where: { userId_marketId_outcomeId: { userId: bad.id, marketId: market.id, outcomeId: yes.id } },
          data: { reservedQuantity: "2" },
        });

        await resolveWithoutAutoSettle(market.id, yes.id, admin.id);

        await expect(settlementService.settleMarket(market.id)).rejects.toThrow(/active reservation/);

        const badPosition = await prisma.position.findUniqueOrThrow({
          where: { userId_marketId_outcomeId: { userId: bad.id, marketId: market.id, outcomeId: yes.id } },
        });
        expect(badPosition.settledAt).toBeNull(); // its own transaction rolled back — never partially settled
        expect(await prisma.positionSettlement.findUnique({ where: { positionId: badPosition.id } })).toBeNull();

        const midwayMarket = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
        expect(midwayMarket.status).toBe("RESOLVING"); // not yet RESOLVED — settlement incomplete

        // Fix the corruption and retry.
        await prisma.position.update({
          where: { userId_marketId_outcomeId: { userId: bad.id, marketId: market.id, outcomeId: yes.id } },
          data: { reservedQuantity: "0" },
        });

        const retryResult = await resolutionService.retrySettlement(market.id, admin.id);
        expect(retryResult.remaining).toBe(0);
        expect(retryResult.resolved).toBe(true);

        expect((await getUserAccount(good1.id, "USDC"))?.cachedBalance.toString()).toBe("10");
        expect((await getUserAccount(bad.id, "USDC"))?.cachedBalance.toString()).toBe("5");
        expect((await getUserAccount(good2.id, "USDC"))?.cachedBalance.toString()).toBe("7");

        // No duplicates for whichever positions had already settled
        // before the failure — exactly one row per position, total 3.
        expect(await prisma.positionSettlement.count({ where: { marketId: market.id } })).toBe(3);

        const finalMarket = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
        expect(finalMarket.status).toBe("RESOLVED");
      },
    );

    it("retrySettlement rejects a non-admin caller", async () => {
      const { admin, market, yes } = await setupClosedMarket();
      const trader = await createTestUser();
      await grantPositionForTest(trader.id, market.id, yes.id, "5");
      await resolveWithoutAutoSettle(market.id, yes.id, admin.id);

      await expect(resolutionService.retrySettlement(market.id, trader.id)).rejects.toThrow(ForbiddenException);
      const finalMarket = await prisma.market.findUniqueOrThrow({ where: { id: market.id } });
      expect(finalMarket.status).toBe("RESOLVING"); // untouched by the rejected attempt
    });
  });
});
