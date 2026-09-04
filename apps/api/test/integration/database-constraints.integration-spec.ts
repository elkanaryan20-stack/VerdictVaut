import { Prisma } from "@prisma/client";
import { createTestUser, getAsset, getAssetNetwork, prisma, provisionAddress } from "./helpers";

/**
 * These bypass the application layer entirely (raw SQL, or Prisma calls
 * with data no DTO would ever validate) to prove the database itself
 * — not just LedgerService — refuses to store an invalid financial
 * state. This is the backstop the audit asked for: even a bug elsewhere
 * in the codebase, or a hand-run migration/fix, cannot silently violate
 * these invariants.
 */
describe("Database-level financial invariants (real Postgres)", () => {
  it("rejects a negative cachedBalance on a USER ledger account", async () => {
    const user = await createTestUser();
    const asset = await getAsset("USDC");

    await expect(
      prisma.$executeRaw`
        INSERT INTO "ledger_accounts" ("id", "ownerType", "userId", "assetId", "cachedBalance", "reservedBalance", "updatedAt")
        VALUES (gen_random_uuid()::text, 'USER', ${user.id}, ${asset.id}, -10, 0, NOW())
      `,
    ).rejects.toThrow(/ledger_accounts_user_balance_check/);
  });

  it("rejects reservedBalance greater than cachedBalance on a USER account", async () => {
    const user = await createTestUser();
    const asset = await getAsset("USDC");

    await expect(
      prisma.$executeRaw`
        INSERT INTO "ledger_accounts" ("id", "ownerType", "userId", "assetId", "cachedBalance", "reservedBalance", "updatedAt")
        VALUES (gen_random_uuid()::text, 'USER', ${user.id}, ${asset.id}, 10, 20, NOW())
      `,
    ).rejects.toThrow(/ledger_accounts_user_balance_check/);
  });

  it("rejects a USER-owned account that also carries a houseAccountKey (invalid state combination)", async () => {
    const user = await createTestUser();
    const asset = await getAsset("USDC");

    await expect(
      prisma.$executeRaw`
        INSERT INTO "ledger_accounts" ("id", "ownerType", "userId", "houseAccountKey", "assetId", "cachedBalance", "reservedBalance", "updatedAt")
        VALUES (gen_random_uuid()::text, 'USER', ${user.id}, 'EXTERNAL_CHAIN', ${asset.id}, 0, 0, NOW())
      `,
    ).rejects.toThrow(/ledger_accounts_owner_ref_check/);
  });

  it("allows a HOUSE account's cachedBalance to go negative (EXTERNAL_CHAIN is exempt by design)", async () => {
    const asset = await getAsset("BTC");

    await expect(
      prisma.$executeRaw`
        INSERT INTO "ledger_accounts" ("id", "ownerType", "houseAccountKey", "assetId", "cachedBalance", "reservedBalance", "updatedAt")
        VALUES (gen_random_uuid()::text, 'HOUSE', 'FEE_REVENUE', ${asset.id}, -500, 0, NOW())
      `,
    ).resolves.toBeDefined();
  });

  it("rejects a non-positive deposit amount", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");
    const asset = await getAsset("USDC");
    const address = await provisionAddress(assetNetwork.id, `0xCheckConstraint${Date.now()}${Math.random()}`);

    await expect(
      prisma.$executeRaw`
        INSERT INTO "deposits" ("id", "userId", "assetId", "assetNetworkId", "walletAddressId", "txHash", "amount", "confirmations", "requiredConfirmations", "status", "detectedAt")
        VALUES (gen_random_uuid()::text, ${user.id}, ${asset.id}, ${assetNetwork.id}, ${address.id}, ${"0xnegativeamount" + Date.now()}, -5, 0, 12, 'PENDING', NOW())
      `,
    ).rejects.toThrow(/deposits_amount_positive_check/);
  });

  it("rejects a non-positive order quantity", async () => {
    const user = await createTestUser();
    const category = await prisma.marketCategory.create({
      data: { slug: `test-cat-${Date.now()}-${Math.random()}`, name: "Test Category" },
    });
    const market = await prisma.market.create({
      data: {
        slug: `test-market-${Date.now()}-${Math.random()}`,
        title: "Test market",
        description: "test",
        categoryId: category.id,
        createdById: user.id,
      },
    });
    const outcome = await prisma.marketOutcome.create({ data: { marketId: market.id, label: "YES" } });

    await expect(
      prisma.$executeRaw`
        INSERT INTO "orders" ("id", "userId", "marketId", "outcomeId", "side", "type", "quantity", "filledQuantity", "status", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${user.id}, ${market.id}, ${outcome.id}, 'BUY', 'MARKET', 0, 0, 'OPEN', NOW(), NOW())
      `,
    ).rejects.toThrow(/orders_quantity_positive_check/);
  });

  it("enforces the idempotencyKey uniqueness on ledger_transactions at the DB level", async () => {
    const asset = await getAsset("ETH");
    const key = `explicit-constraint-test-${Date.now()}-${Math.random()}`;

    await prisma.ledgerTransaction.create({
      data: { assetId: asset.id, type: "ADJUSTMENT", referenceType: "Test", referenceId: "t-1", idempotencyKey: key },
    });

    await expect(
      prisma.ledgerTransaction.create({
        data: { assetId: asset.id, type: "ADJUSTMENT", referenceType: "Test", referenceId: "t-2", idempotencyKey: key },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
  });
});
