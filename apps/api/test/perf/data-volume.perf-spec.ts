import { createTestMarket, createTestSuperAdmin, createTestUser, fundUserForTest, grantPositionForTest, openMarketForTest, orderBookService, ordersService, prisma } from "../integration/helpers";
import { printResult, runLoad } from "./perf-util";

/**
 * Phase 38 — how read paths behave as data grows.
 *   1. Order-book depth: every incoming order loads the opposite side's
 *      resting orders (getRestingCandidates), and the public book endpoint
 *      loads every resting order (getBook). Measured at increasing depth.
 *   2. Per-user list queries on a large, many-user table: EXPLAIN ANALYZE
 *      of the real query shapes, inside a transaction that is ROLLED BACK —
 *      the bulk rows exist only for the plan and never persist.
 */

const DEPTHS = (process.env.PERF_DEPTHS ?? "100,1000,4000").split(",").map(Number);

async function planFor(sql: string, params: unknown[] = []) {
  const rows = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, ...params);
  return rows.map((r) => r["QUERY PLAN"]).join("\n");
}

describe("Phase 38 — data volume", () => {
  it("order-book depth: incoming-order matching and public book reads", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    const bidders = await Promise.all(Array.from({ length: 50 }, () => createTestUser()));
    for (const b of bidders) await fundUserForTest(b.id, "USDC", "1000000");
    const seller = await createTestUser();
    await grantPositionForTest(seller.id, market.id, yes.id, "1000000");

    let resting = 0;
    for (const depth of DEPTHS) {
      // Grow the bid side with non-crossing resting BUYs (low prices, no NO bids -> no minting).
      const toAdd = depth - resting;
      await runLoad("setup", toAdd, 16, async (i) => {
        const price = (0.01 + ((resting + i) % 20) * 0.005).toFixed(3);
        await ordersService.create(bidders[(resting + i) % bidders.length].id, { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", price, quantity: "1" } as never);
      });
      resting = depth;

      const book = await runLoad(`book.getBook.depth-${depth}`, 200, 8, () => orderBookService.getBook(market.id, yes.id));
      printResult(book, { depth, levels: (await orderBookService.getBook(market.id, yes.id)).bids.length });

      const candidates = await runLoad(`book.getRestingCandidates.depth-${depth}`, 200, 8, () => orderBookService.getRestingCandidates(market.id, yes.id, "BUY"));
      printResult(candidates, { depth });

      // End-to-end: a non-crossing SELL that must still load every resting bid to find nothing to cross.
      const place = await runLoad(`order.nonCrossingSell.depth-${depth}`, 60, 4, async () => {
        const order = await ordersService.create(seller.id, { marketId: market.id, outcomeId: yes.id, side: "SELL", type: "LIMIT", price: "0.99", quantity: "1" } as never);
        await ordersService.cancel(seller.id, order.id);
      });
      printResult(place, { depth, note: "place + cancel, sell side" });
    }

    const plan = await planFor(
      `SELECT id, "userId", side, price, "remainingQuantity", sequence FROM orders WHERE "marketId" = $1 AND "outcomeId" = $2 AND side = 'BUY' AND status IN ('OPEN','PARTIALLY_FILLED') AND price IS NOT NULL ORDER BY price DESC, sequence ASC`,
      [market.id, yes.id],
    );
    // eslint-disable-next-line no-console
    console.log(`PERF-PLAN getRestingCandidates\n${plan}`);
  });

  it("per-user list queries on a large many-user table (EXPLAIN ANALYZE, rolled back)", async () => {
    const admin = await createTestSuperAdmin();
    const { market, yes } = await createTestMarket(admin.id);
    const target = await createTestUser();
    const others = await Promise.all(Array.from({ length: 20 }, () => createTestUser()));
    const ROLLBACK = new Error("rollback — plan-only dataset");

    await prisma
      .$transaction(
        async (tx) => {
          // 200k synthetic fills across 20 users + 50 for the target user,
          // and 100k audit rows — present only inside this transaction.
          const ids = others.map((o) => `'${o.id}'`).join(",");
          // Plan-only rows with no backing orders: FK triggers are skipped for
          // THIS transaction only (SET LOCAL), CHECK constraints still apply,
          // and the whole transaction is rolled back below.
          await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
          await tx.$executeRawUnsafe(`
            INSERT INTO fills (id, "marketId", "outcomeId", "buyOrderId", "sellOrderId", "makerOrderId", "takerOrderId", "buyerUserId", "sellerUserId", price, quantity, "idempotencyKey", "executedAt")
            SELECT gen_random_uuid(), '${market.id}', '${yes.id}', b, s, b, s,
                   (ARRAY[${ids}])[1 + (g % 20)], (ARRAY[${ids}])[1 + ((g + 7) % 20)], 0.5, 1, 'perf-fill-' || g, now() - (g || ' seconds')::interval
            FROM (SELECT g, gen_random_uuid() AS b, gen_random_uuid() AS s FROM generate_series(1, 200000) g) x`);
          await tx.$executeRawUnsafe(`
            INSERT INTO fills (id, "marketId", "outcomeId", "buyOrderId", "sellOrderId", "makerOrderId", "takerOrderId", "buyerUserId", "sellerUserId", price, quantity, "idempotencyKey", "executedAt")
            SELECT gen_random_uuid(), '${market.id}', '${yes.id}', b, s, b, s,
                   '${target.id}', (ARRAY[${ids}])[1 + (g % 20)], 0.5, 1, 'perf-target-fill-' || g, now()
            FROM (SELECT g, gen_random_uuid() AS b, gen_random_uuid() AS s FROM generate_series(1, 50) g) x`);
          await tx.$executeRawUnsafe(`
            INSERT INTO audit_logs (id, "actorType", action, "resourceType", "resourceId", "createdAt")
            SELECT gen_random_uuid(), 'SYSTEM', 'perf.synthetic', 'Withdrawal', gen_random_uuid()::text, now() - (g || ' seconds')::interval
            FROM generate_series(1, 100000) g`);
          await tx.$executeRawUnsafe(`ANALYZE fills`);
          await tx.$executeRawUnsafe(`ANALYZE audit_logs`);

          const q = async (label: string, sql: string) => {
            const rows = await tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`);
            // eslint-disable-next-line no-console
            console.log(`PERF-PLAN ${label}\n${rows.map((r) => r["QUERY PLAN"]).join("\n")}`);
          };
          await q(
            "fills.listMine (FillsService: OR buyer/seller, ORDER BY executedAt DESC LIMIT 20)",
            `SELECT * FROM fills WHERE ("buyerUserId" = '${target.id}' OR "sellerUserId" = '${target.id}') ORDER BY "executedAt" DESC LIMIT 20 OFFSET 0`,
          );
          await q("fills.listMine count", `SELECT count(*) FROM fills WHERE ("buyerUserId" = '${target.id}' OR "sellerUserId" = '${target.id}')`);
          await q("auditLogs.list (AuditLogService: ORDER BY createdAt DESC LIMIT 200)", `SELECT * FROM audit_logs ORDER BY "createdAt" DESC LIMIT 200`);
          await q("auditLogs.list by resourceType", `SELECT * FROM audit_logs WHERE "resourceType" = 'Withdrawal' ORDER BY "createdAt" DESC LIMIT 200`);
          throw ROLLBACK;
        },
        { timeout: 600_000, maxWait: 60_000 },
      )
      .catch((error) => {
        if (error !== ROLLBACK) throw error;
      });

    expect(await prisma.fill.count({ where: { idempotencyKey: { startsWith: "perf-" } } })).toBe(0);
  });
});
