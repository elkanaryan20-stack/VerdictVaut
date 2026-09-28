import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { AuthService } from "../../src/auth/auth.service";
import {
  auditLog,
  createTestMarket,
  createTestSuperAdmin,
  createTestUser,
  fundUserForTest,
  grantPositionForTest,
  openMarketForTest,
  ordersService,
  prisma,
} from "./helpers";

/**
 * Phase 37 — adversarial regression tests, real Postgres.
 */

const jwtConfig = {
  get: () => ({ accessSecret: "test-access-secret", refreshSecret: "test-refresh-secret", accessTtl: "15m", refreshTtl: "7d" }),
};

function makeAuthService() {
  return new AuthService(prisma, new JwtService(), jwtConfig as never, auditLog);
}

async function userWithPassword(password: string) {
  const user = await createTestUser("ACTIVE", "USER");
  return prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 4) } });
}

describe("Phase 37 — order price precision vs. storage precision", () => {
  it("rejects a BUY price that would be stored ROUNDED UP to 1.000000 (Order.price is Decimal(18,6)) — never persists a price outside (0, 1)", async () => {
    const admin = await createTestSuperAdmin();
    const buyer = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await fundUserForTest(buyer.id, "USDC", "1000");

    await expect(
      ordersService.create(buyer.id, { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", price: "0.9999996", quantity: "100" } as never),
    ).rejects.toThrow(BadRequestException);

    const stored = await prisma.order.findMany({ where: { marketId: market.id } });
    expect(stored.every((o) => o.price!.greaterThan(0) && o.price!.lessThan(1))).toBe(true);
  });

  it("rejects a SELL price that would be stored ROUNDED DOWN to 0.000000", async () => {
    const admin = await createTestSuperAdmin();
    const seller = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await grantPositionForTest(seller.id, market.id, yes.id, "100");

    await expect(
      ordersService.create(seller.id, { marketId: market.id, outcomeId: yes.id, side: "SELL", type: "LIMIT", price: "0.0000004", quantity: "10" } as never),
    ).rejects.toThrow(BadRequestException);
    expect(await prisma.order.count({ where: { marketId: market.id } })).toBe(0);
  });

  it("rejects a quantity finer than the Decimal(36,18) columns (would be stored as a zero-quantity resting order)", async () => {
    const admin = await createTestSuperAdmin();
    const buyer = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await fundUserForTest(buyer.id, "USDC", "1000");

    await expect(
      ordersService.create(buyer.id, { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", price: "0.5", quantity: "0.0000000000000000001" } as never),
    ).rejects.toThrow(BadRequestException);
    expect(await prisma.order.count({ where: { marketId: market.id } })).toBe(0);
  });

  it("P1 regression: an IN-RANGE over-precise bid (0.4999996, stored 0.500000, reserved at 0.4999996) can no longer freeze matching for crossing sellers", async () => {
    const admin = await createTestSuperAdmin();
    const buyer = await createTestUser();
    const seller = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await fundUserForTest(buyer.id, "USDC", "1000");
    await grantPositionForTest(seller.id, market.id, yes.id, "100");

    // Before the fix this was accepted, stored at 0.500000 with only 49.99996
    // reserved, and every crossing SELL then failed with "Cannot consume 50".
    await expect(
      ordersService.create(buyer.id, { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", price: "0.4999996", quantity: "100" } as never),
    ).rejects.toThrow(BadRequestException);

    // The honest equivalent at storage precision rests and crosses normally.
    await ordersService.create(buyer.id, { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", price: "0.5", quantity: "100" } as never);
    const ask = await ordersService.create(seller.id, { marketId: market.id, outcomeId: yes.id, side: "SELL", type: "LIMIT", price: "0.5", quantity: "100" } as never);
    expect(ask.status).toBe("FILLED");
  });

  it("still accepts a price at exactly the stored precision", async () => {
    const admin = await createTestSuperAdmin();
    const buyer = await createTestUser();
    const { market, yes } = await createTestMarket(admin.id);
    await openMarketForTest(market.id, admin.id);
    await fundUserForTest(buyer.id, "USDC", "1000");

    const order = await ordersService.create(buyer.id, { marketId: market.id, outcomeId: yes.id, side: "BUY", type: "LIMIT", price: "0.999999", quantity: "10" } as never);
    expect(order.price!.toString()).toBe("0.999999");
  });
});

describe("Phase 37 — refresh-token rotation under attack", () => {
  it("two CONCURRENT presentations of the same refresh token: exactly one new session is minted, never two", async () => {
    const user = await userWithPassword("correct-horse-battery");
    const auth = makeAuthService();
    const { refreshToken } = await auth.login({ email: user.email, password: "correct-horse-battery" });

    const results = await Promise.allSettled([auth.refresh(refreshToken), auth.refresh(refreshToken), auth.refresh(refreshToken)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedException);
    }
    // At most ONE live successor. (Zero is also safe: a duplicate that
    // arrives just after the winner rotated sees an already-revoked token
    // and takes the reuse-detection path, revoking everything.)
    const live = await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } });
    expect(live).toBeLessThanOrEqual(1);
  });

  it("tokens minted in the same second are distinct (no shared tokenHash across sessions)", async () => {
    const user = await userWithPassword("correct-horse-battery");
    const auth = makeAuthService();
    const [a, b] = await Promise.all([
      auth.login({ email: user.email, password: "correct-horse-battery" }),
      auth.login({ email: user.email, password: "correct-horse-battery" }),
    ]);
    expect(a.refreshToken).not.toBe(b.refreshToken);
    expect(a.accessToken).not.toBe(b.accessToken);
    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(new Set(rows.map((r) => r.tokenHash)).size).toBe(rows.length);
  });

  it("an immediate rotation never re-mints the rotated-out token, so the NEW token keeps working (no false reuse alarm)", async () => {
    const user = await userWithPassword("correct-horse-battery");
    const auth = makeAuthService();
    const first = await auth.login({ email: user.email, password: "correct-horse-battery" });
    const second = await auth.refresh(first.refreshToken); // same second as login
    expect(second.refreshToken).not.toBe(first.refreshToken);

    const third = await auth.refresh(second.refreshToken);
    expect(third.refreshToken).toBeTruthy();
    const reuseAlarms = await prisma.auditLog.count({ where: { resourceId: user.id, action: "user.refresh_token_reuse_detected" } });
    expect(reuseAlarms).toBe(0);
  });

  it("a LATER replay of a rotated-out token still triggers reuse detection and revokes every session", async () => {
    const user = await userWithPassword("correct-horse-battery");
    const auth = makeAuthService();
    const first = await auth.login({ email: user.email, password: "correct-horse-battery" });
    await auth.refresh(first.refreshToken);

    await expect(auth.refresh(first.refreshToken)).rejects.toThrow(UnauthorizedException);
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });
});
