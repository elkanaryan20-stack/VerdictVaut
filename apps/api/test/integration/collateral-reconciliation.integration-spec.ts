import { CollateralReconciliationService } from "../../src/settlement/collateral-reconciliation.service";
import { IndependentReconciliationService } from "../../src/wallet/reconciliation/independent-reconciliation.service";
import {
  auditLog,
  createTestMarket,
  createTestSuperAdmin,
  createTestUser,
  fundUserForTest,
  openMarketForTest,
  ordersService,
  prisma,
  resolutionService,
} from "./helpers";

const collateralReconciliation = new CollateralReconciliationService(prisma, auditLog);

async function placeBuy(userId: string, marketId: string, outcomeId: string, price: string, quantity: string) {
  return ordersService.create(userId, { marketId, outcomeId, side: "BUY", type: "LIMIT", price, quantity } as never);
}

async function mintTenShares(adminId: string) {
  const { market, yes, no } = await createTestMarket(adminId);
  await openMarketForTest(market.id, adminId);
  const buyerYes = await createTestUser();
  const buyerNo = await createTestUser();
  await fundUserForTest(buyerYes.id, "USDC", "100");
  await fundUserForTest(buyerNo.id, "USDC", "100");
  await placeBuy(buyerNo.id, market.id, no.id, "0.4", "10");
  await placeBuy(buyerYes.id, market.id, yes.id, "0.6", "10");
  return { market, yes, no, buyerYes, buyerNo };
}

/**
 * Phase 13 — proves the collateral reconciliation check this phase adds
 * actually catches the exact gap the Phase 13 audit exposed: nothing had
 * ever independently verified that a market's own collateral
 * LedgerAccount balance equals totalMinted - totalPaidOut. These tests
 * deliberately corrupt the ledger balance directly (bypassing every real
 * code path, the way a real bug or a manual DB intervention would) to
 * prove the check actually notices — a check that only ever sees
 * healthy state proves nothing.
 */
describe("Collateral reconciliation (real Postgres)", () => {
  it("reports OK with no discrepancy for a freshly-minted, unsettled market", async () => {
    const admin = await createTestSuperAdmin();
    const { market } = await mintTenShares(admin.id);

    const { run, discrepancy } = await collateralReconciliation.checkMarket(market.id, admin.id);

    expect(run.status).toBe("OK");
    expect(discrepancy).toBeNull();
  });

  it("reports OK after full settlement — collateral reaches exactly zero", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes } = await mintTenShares(admin.id);
    const { marketsService } = await import("./helpers");
    await marketsService.close(market.id, admin.id);
    await resolutionService.resolve(market.id, admin.id, yes.id);

    const { run, discrepancy } = await collateralReconciliation.checkMarket(market.id, admin.id);

    expect(run.status).toBe("OK");
    expect(discrepancy).toBeNull();
  });

  it("detects a genuine shortfall as CRITICAL", async () => {
    const admin = await createTestSuperAdmin();
    const { market } = await mintTenShares(admin.id);
    const asset = await prisma.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } });

    // Simulate real-world corruption (a bug, a bad manual DB edit) —
    // never how legitimate code reaches this state.
    await prisma.ledgerAccount.update({
      where: { marketId_assetId: { marketId: market.id, assetId: asset.id } },
      data: { cachedBalance: "4" }, // should be 10
    });

    const { run, discrepancy } = await collateralReconciliation.checkMarket(market.id, admin.id);

    expect(run.status).toBe("DISCREPANCY_FOUND");
    expect(discrepancy).not.toBeNull();
    expect(discrepancy!.severity).toBe("CRITICAL");
    expect(discrepancy!.type).toBe("collateral_balance_mismatch");
    expect((discrepancy!.expectedState as { expectedBalance: string }).expectedBalance).toBe("10");
    expect((discrepancy!.observedState as { actualBalance: string }).actualBalance).toBe("4");
  });

  it("detects a surplus as WARNING, not CRITICAL", async () => {
    const admin = await createTestSuperAdmin();
    const { market } = await mintTenShares(admin.id);
    const asset = await prisma.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } });

    await prisma.ledgerAccount.update({
      where: { marketId_assetId: { marketId: market.id, assetId: asset.id } },
      data: { cachedBalance: "15" }, // should be 10
    });

    const { run, discrepancy } = await collateralReconciliation.checkMarket(market.id, admin.id);

    expect(run.status).toBe("DISCREPANCY_FOUND");
    expect(discrepancy!.severity).toBe("WARNING");
  });

  it("does not create a duplicate discrepancy row for a still-open finding on re-check", async () => {
    const admin = await createTestSuperAdmin();
    const { market } = await mintTenShares(admin.id);
    const asset = await prisma.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } });
    await prisma.ledgerAccount.update({
      where: { marketId_assetId: { marketId: market.id, assetId: asset.id } },
      data: { cachedBalance: "4" },
    });

    const first = await collateralReconciliation.checkMarket(market.id, admin.id);
    const second = await collateralReconciliation.checkMarket(market.id, admin.id);

    expect(second.discrepancy!.id).toBe(first.discrepancy!.id);
    expect(await prisma.reconciliationDiscrepancy.count({ where: { marketId: market.id } })).toBe(1);
    // Each check still records its own run, even when the underlying
    // discrepancy row is reused.
    expect(await prisma.reconciliationRun.count({ where: { marketId: market.id, runType: "COLLATERAL_CHECK" } })).toBe(2);
  });

  it("an OPEN collateral discrepancy can be acknowledged and resolved through the shared IndependentReconciliationService methods", async () => {
    const admin = await createTestSuperAdmin();
    const { market } = await mintTenShares(admin.id);
    const asset = await prisma.asset.findFirstOrThrow({ where: { isSettlementCurrency: true } });
    await prisma.ledgerAccount.update({
      where: { marketId_assetId: { marketId: market.id, assetId: asset.id } },
      data: { cachedBalance: "4" },
    });
    const { discrepancy } = await collateralReconciliation.checkMarket(market.id, admin.id);

    const independentReconciliation = new IndependentReconciliationService(prisma, undefined as never, undefined as never, auditLog);
    const acknowledged = await independentReconciliation.acknowledge(discrepancy!.id, admin.id);
    expect(acknowledged).toBe(true);

    const resolved = await independentReconciliation.resolve(discrepancy!.id, admin.id, "Manually recredited the market's collateral account.");
    expect(resolved).toBe(true);

    const [found] = await independentReconciliation.listDiscrepancies({ marketId: market.id });
    expect(found.status).toBe("RESOLVED");
  });

  it("checkAllMarkets sweeps every market that has ever minted collateral", async () => {
    const admin = await createTestSuperAdmin();
    const { market: marketA } = await mintTenShares(admin.id);
    const { market: marketB } = await mintTenShares(admin.id);

    // The DB is shared across this whole test file (earlier tests
    // deliberately leave corrupted balances behind) — checkAllMarkets
    // sweeps every market with a collateral account, not just this
    // test's own two, so assert on THIS test's markets specifically
    // rather than on the global discrepancy count.
    const summary = await collateralReconciliation.checkAllMarkets(admin.id);

    const byMarketId = new Map(summary.results.map((r) => [r.marketId, r]));
    expect(byMarketId.get(marketA.id)).toMatchObject({ discrepancy: null });
    expect(byMarketId.get(marketB.id)).toMatchObject({ discrepancy: null });
  });
});
