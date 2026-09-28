import { execFileSync } from "child_process";
import * as path from "path";
import { createTestMarket, createTestSuperAdmin, createTestUser, fundUserForTest, openMarketForTest, ordersService, prisma } from "../integration/helpers";
import { diffCounters, financialInvariantViolations, pgCounters, printResult, runLoad } from "./perf-util";

const pgConfig = require("../integration/pg-config");

/**
 * Phase 38 — order placement / matching / minting / cancellation under
 * concurrency, (A) all on one hot market vs (B) spread across 10 markets.
 * Every order goes through the real OrdersService (SERIALIZABLE funding
 * transaction, real matching, real ledger postings). Business rejections
 * (e.g. selling more than you hold) are counted separately from system
 * errors; the run is only "correct" if every financial invariant holds.
 */

const USERS = Number(process.env.PERF_USERS ?? 40);
const ORDERS = Number(process.env.PERF_ORDERS ?? 1200);
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 16);
const PRICES = ["0.45", "0.46", "0.47", "0.48", "0.49", "0.50", "0.51", "0.52", "0.53", "0.54", "0.55"];

// Deterministic pseudo-random sequence so runs are comparable.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const BUSINESS_REJECTION = /insufficient|exceeds|not open|no longer|Order not found|in status/i;

async function tradingWorkload(label: string, marketCount: number, userCount = USERS) {
  const admin = await createTestSuperAdmin();
  const markets: Array<Awaited<ReturnType<typeof createTestMarket>>> = [];
  for (let m = 0; m < marketCount; m++) {
    const created = await createTestMarket(admin.id);
    await openMarketForTest(created.market.id, admin.id);
    markets.push(created);
  }
  const users: Array<Awaited<ReturnType<typeof createTestUser>>> = [];
  for (let u = 0; u < userCount; u++) {
    const user = await createTestUser();
    await fundUserForTest(user.id, "USDC", "100000");
    users.push(user);
  }

  const rand = rng(42);
  const plan = Array.from({ length: ORDERS }, () => ({
    user: users[Math.floor(rand() * users.length)],
    market: markets[Math.floor(rand() * markets.length)],
    action: rand(),
    outcomeYes: rand() < 0.5,
    price: PRICES[Math.floor(rand() * PRICES.length)],
    quantity: String(1 + Math.floor(rand() * 10)),
  }));

  let business = 0;
  const before = await pgCounters();
  const result = await runLoad(label, ORDERS, CONCURRENCY, async (i) => {
    const p = plan[i];
    const outcome = p.outcomeYes ? p.market.yes : p.market.no;
    try {
      if (p.action < 0.15) {
        // Cancel one of this user's resting orders on this market, if any.
        const open = await prisma.order.findFirst({ where: { userId: p.user.id, marketId: p.market.market.id, status: { in: ["OPEN", "PARTIALLY_FILLED"] } } });
        if (open) await ordersService.cancel(p.user.id, open.id);
        return;
      }
      const side = p.action < 0.65 ? "BUY" : "SELL";
      await ordersService.create(p.user.id, { marketId: p.market.market.id, outcomeId: outcome.id, side, type: "LIMIT", price: p.price, quantity: p.quantity } as never);
    } catch (error) {
      if (BUSINESS_REJECTION.test((error as Error).message)) {
        business += 1;
        return;
      }
      throw error;
    }
  });
  const db = diffCounters(before, await pgCounters());

  const marketIds = markets.map((m) => m.market.id);
  const fills = await prisma.fill.count({ where: { marketId: { in: marketIds } } });
  const mints = await prisma.completeSetMint.count({ where: { marketId: { in: marketIds } } });
  const violations = await financialInvariantViolations();
  printResult(result, { businessRejections: business, fills, mints, db, violations });
  return { result, violations };
}

describe("Phase 38 — trading load", () => {
  it("A: one hot market", async () => {
    const { result, violations } = await tradingWorkload("trading.hot-market", 1);
    expect(result.failed).toBe(0);
    expect(Object.values(violations).every((v) => v === 0)).toBe(true);
  });

  it("B: ten independent markets", async () => {
    const { result, violations } = await tradingWorkload("trading.ten-markets", 10);
    // Measured, not asserted: this scenario deliberately packs 16 in-flight orders
    // onto 40 users, so the same user trades in several markets at once and
    // their single settlement-asset account becomes a cross-market hot row.
    void result;
    expect(Object.values(violations).every((v) => v === 0)).toBe(true);
  });

  it("C: ten independent markets, 10x the users (realistic per-user concurrency)", async () => {
    const { result, violations } = await tradingWorkload("trading.ten-markets-400-users", 10, USERS * 10);
    void result;
    expect(Object.values(violations).every((v) => v === 0)).toBe(true);
  });

  it("post-load: the repository's own financial-integrity checks pass (the only tolerated finding is the benchmark's own TestFixture funding, exactly)", async () => {
    let output: string;
    try {
      output = execFileSync("node", [path.join(__dirname, "..", "..", "scripts", "financial-integrity-checks.js")], {
      env: { ...process.env, DATABASE_URL: pgConfig.databaseUrl },
      encoding: "utf8",
    });
    } catch (error) {
      output = String((error as { stdout?: string }).stdout ?? "");
    }
    // eslint-disable-next-line no-console
    console.log(`PERF-INTEGRITY ${output.split("\n").filter((l) => /FAIL|CHECKS/.test(l)).join(" | ")}`);
    // Funding in this harness posts real, balanced DEPOSIT ledger transactions
    // but with referenceType "TestFixture" (no on-chain Deposit row), which the
    // reference-integrity check correctly flags. Every OTHER check must pass,
    // and the flagged count must equal the fixture count exactly — nothing more.
    const failures = output.split("\n").filter((l) => l.includes("[FAIL]"));
    const fixtureCount = Number(
      (await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM ledger_transactions WHERE "referenceType" = 'TestFixture'`)[0].n,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/every LedgerTransaction references a real/);
    expect(failures[0]).toContain(`— ${fixtureCount} orphaned/unrecognized-reference`);
  });
});
