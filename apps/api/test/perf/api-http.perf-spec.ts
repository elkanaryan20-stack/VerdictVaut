import { INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import * as bcrypt from "bcryptjs";
import helmet from "helmet";
import { AddressInfo } from "net";
import { createTestMarket, createTestSuperAdmin, createTestUser, fundUserForTest, openMarketForTest, prisma } from "../integration/helpers";
import { printResult, runLoad } from "./perf-util";

const pgConfig = require("../integration/pg-config");

/**
 * Phase 38 — HTTP-level baseline through the REAL AppModule (guards,
 * throttler, validation pipe, exception filter, Prisma), booted in-process
 * against the throwaway benchmark database, configured as behind one proxy
 * (TRUST_PROXY_HOPS=1) so every virtual client can present its own
 * X-Forwarded-For address — exactly how distinct users reach it via the ALB.
 *
 * Limitation: the load generator shares the API's Node event loop (one
 * process), so these latencies include client-side overhead and are
 * conservative; they are LOCAL measurements, not production capacity.
 */

const PASSWORD = "perf-benchmark-password";
let app: INestApplication;
let base = "";
let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};

async function call(path: string, init: { method?: string; token?: string; body?: unknown; ip?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": init.ip ?? nextIp(),
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    error.name = `HTTP${res.status}`;
    throw error;
  }
  return text ? JSON.parse(text) : undefined;
}

beforeAll(async () => {
  Object.assign(process.env, {
    DATABASE_URL: pgConfig.databaseUrl,
    JWT_ACCESS_SECRET: "perf-access-secret-0000000000000000000000",
    JWT_REFRESH_SECRET: "perf-refresh-secret-111111111111111111111",
    APP_ENVIRONMENT: "sandbox",
    NODE_ENV: "test",
    TRUST_PROXY_HOPS: "1",
  });
  const { AppModule } = await import("../../src/app.module");
  const { AllExceptionsFilter } = await import("../../src/common/filters/http-exception.filter");
  const { configureTrustProxy } = await import("../../src/config/trust-proxy");
  const { requestIdMiddleware } = await import("../../src/observability/request-id.middleware");
  app = await NestFactory.create(AppModule, { logger: false });
  // Same HTTP pipeline as main.ts.
  app.use(requestIdMiddleware);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  configureTrustProxy(app.getHttpAdapter().getInstance(), 1);
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
});

describe("Phase 38 — HTTP API baseline", () => {
  it("measures read, mutating, admin, auth and rate-limit behaviour", async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 12); // production cost factor (AuthService)
    const admin = await createTestSuperAdmin();
    await prisma.user.update({ where: { id: admin.id }, data: { passwordHash } });
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);

    const users: Array<{ id: string; email: string }> = [];
    for (let i = 0; i < 20; i++) {
      const u = await createTestUser();
      await prisma.user.update({ where: { id: u.id }, data: { passwordHash } });
      await fundUserForTest(u.id, "USDC", "100000");
      users.push(u);
    }

    // ── Auth: login throughput + its effect on concurrent reads ─────────
    const readsAlone = await runLoad("http.GET /markets (idle baseline)", 200, 4, () => call("/markets"));
    printResult(readsAlone);
    const [logins, readsDuringLogin] = await Promise.all([
      runLoad("http.POST /auth/login (bcryptjs cost 12)", 40, 4, (i) => call("/auth/login", { method: "POST", body: { email: users[i % users.length].email, password: PASSWORD } })),
      runLoad("http.GET /markets (during logins)", 200, 4, () => call("/markets")),
    ]);
    printResult(logins);
    printResult(readsDuringLogin);

    const tokens = await Promise.all(users.map((u) => call("/auth/login", { method: "POST", body: { email: u.email, password: PASSWORD } }).then((t) => t.accessToken as string)));
    const adminToken = (await call("/auth/login", { method: "POST", body: { email: admin.email, password: PASSWORD } })).accessToken as string;
    const refreshTokens = await Promise.all(users.map((u) => call("/auth/login", { method: "POST", body: { email: u.email, password: PASSWORD } }).then((t) => t.refreshToken as string)));
    printResult(await runLoad("http.POST /auth/refresh", refreshTokens.length, 4, (i) => call("/auth/refresh", { method: "POST", body: { refreshToken: refreshTokens[i] } })));

    // ── Public reads ─────────────────────────────────────────────────────
    const N = 400;
    const C = 16;
    printResult(await runLoad("http.GET /markets", N, C, () => call("/markets")));
    printResult(await runLoad("http.GET /markets/:slug", N, C, () => call(`/markets/${market.slug}`)));
    printResult(await runLoad("http.GET order book", N, C, () => call(`/trading/markets/${market.id}/outcomes/${yes.id}/book`)));

    // ── Authenticated reads ──────────────────────────────────────────────
    const t = (i: number) => tokens[i % tokens.length];
    for (const path of ["/wallet/balances", "/wallet/deposits", "/wallet/withdrawals", "/trading/orders", "/trading/positions", "/trading/fills"]) {
      printResult(await runLoad(`http.GET ${path}`, N, C, (i) => call(path, { token: t(i) })));
    }

    // ── Mutations (each followed by its cancel) ──────────────────────────
    printResult(
      await runLoad("http.POST /trading/orders + cancel", 200, C, async (i) => {
        const placed = await call("/trading/orders", {
          method: "POST",
          token: t(i),
          body: { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", price: "0.2", quantity: "1" },
        });
        await call(`/trading/orders/${placed.orderId ?? placed.id}/cancel`, { method: "POST", token: t(i) });
      }),
    );
    printResult(
      await runLoad("http.POST /wallet/withdrawals + cancel", 100, C, async (i) => {
        const w = await call("/wallet/withdrawals", {
          method: "POST",
          token: t(i),
          body: { assetSymbol: "USDC", networkCode: "ethereum-sepolia", amount: "1", destinationAddress: "0x000000000000000000000000000000000000dEaD" },
        });
        await call(`/wallet/withdrawals/${w.id}/cancel`, { method: "POST", token: t(i) });
      }),
    );

    // ── Admin reads ──────────────────────────────────────────────────────
    for (const path of ["/admin/withdrawals", "/admin/withdrawals/stale", "/admin/audit-logs", "/admin/jobs", "/admin/reconciliation/discrepancies"]) {
      printResult(await runLoad(`http.GET ${path}`, 200, 8, () => call(path, { token: adminToken })));
    }

    // ── Rate limiting stays per client under concurrency ─────────────────
    const noisy = await runLoad("ratelimit.noisy-client (one IP, 150 req)", 150, 8, () => call("/markets", { ip: "203.0.113.7" }));
    const quiet = await runLoad("ratelimit.other-clients (distinct IPs, 150 req)", 150, 8, () => call("/markets"));
    printResult(noisy);
    printResult(quiet);
    expect(noisy.errors["HTTP429"] ?? Object.entries(noisy.errors).filter(([k]) => k.startsWith("HTTP429")).reduce((a, [, v]) => a + v, 0)).toBeGreaterThan(0);
    expect(quiet.failed).toBe(0);

    // ── Heap after sustained reads (indicative only — not leak-proofing) ─
    const heapBefore = process.memoryUsage().heapUsed;
    await runLoad("http.GET /markets (3000 sustained)", 3000, C, () => call("/markets"));
    const heapAfter = process.memoryUsage().heapUsed;
    // eslint-disable-next-line no-console
    console.log(`PERF-HEAP ${JSON.stringify({ heapBeforeMb: Math.round(heapBefore / 1e6), heapAfterMb: Math.round(heapAfter / 1e6) })}`);
  });
});
