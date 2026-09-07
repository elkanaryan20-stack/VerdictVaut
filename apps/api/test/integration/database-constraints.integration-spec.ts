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

  it("rejects a deposit inserted directly as CREDITED with no ledgerTransactionId (Phase 8 hardening)", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");
    const asset = await getAsset("USDC");
    const address = await provisionAddress(assetNetwork.id, `0xCreditedNoLedgerRef${Date.now()}${Math.random()}`);

    await expect(
      prisma.$executeRaw`
        INSERT INTO "deposits" ("id", "userId", "assetId", "assetNetworkId", "walletAddressId", "txHash", "amount", "confirmations", "requiredConfirmations", "status", "detectedAt")
        VALUES (gen_random_uuid()::text, ${user.id}, ${asset.id}, ${assetNetwork.id}, ${address.id}, ${"0xcreditednoledgerref" + Date.now()}, 10, 12, 12, 'CREDITED', NOW())
      `,
    ).rejects.toThrow(/deposits_credited_consistency_check/);
  });

  it("rejects a non-CREDITED deposit that carries a ledgerTransactionId (Phase 8 hardening)", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");
    const asset = await getAsset("USDC");
    const address = await provisionAddress(assetNetwork.id, `0xPendingWithLedgerRef${Date.now()}${Math.random()}`);

    await expect(
      prisma.$executeRaw`
        INSERT INTO "deposits" ("id", "userId", "assetId", "assetNetworkId", "walletAddressId", "txHash", "amount", "confirmations", "requiredConfirmations", "status", "detectedAt", "ledgerTransactionId")
        VALUES (gen_random_uuid()::text, ${user.id}, ${asset.id}, ${assetNetwork.id}, ${address.id}, ${"0xpendingwithledgerref" + Date.now()}, 10, 0, 12, 'PENDING', NOW(), gen_random_uuid()::text)
      `,
    ).rejects.toThrow(/deposits_credited_consistency_check/);
  });

  it("rejects a withdrawal inserted directly as BROADCAST with no txHash (Phase 9 hardening)", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");

    await expect(
      prisma.$executeRaw`
        INSERT INTO "withdrawals" ("id", "userId", "assetNetworkId", "destinationAddress", "amount", "status", "clientWithdrawalId", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${user.id}, ${assetNetwork.id}, '0x000000000000000000000000000000000000dEaD', 10, 'BROADCAST', ${"ck-" + Date.now() + Math.random()}, NOW(), NOW())
      `,
    ).rejects.toThrow(/withdrawals_broadcast_requires_txhash_check/);
  });

  it("allows a withdrawal inserted as BROADCAST when a txHash is present (Phase 9 hardening)", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");

    await expect(
      prisma.$executeRaw`
        INSERT INTO "withdrawals" ("id", "userId", "assetNetworkId", "destinationAddress", "amount", "status", "txHash", "clientWithdrawalId", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${user.id}, ${assetNetwork.id}, '0x000000000000000000000000000000000000dEaD', 10, 'BROADCAST', '0xrealhash', ${"ck-" + Date.now() + Math.random()}, NOW(), NOW())
      `,
    ).resolves.toBeDefined();
  });

  it("rejects a withdrawal whose fee is not strictly less than its amount (Phase 9 hardening)", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");

    await expect(
      prisma.$executeRaw`
        INSERT INTO "withdrawals" ("id", "userId", "assetNetworkId", "destinationAddress", "amount", "fee", "clientWithdrawalId", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${user.id}, ${assetNetwork.id}, '0x000000000000000000000000000000000000dEaD', 10, 10, ${"ck-" + Date.now() + Math.random()}, NOW(), NOW())
      `,
    ).rejects.toThrow(/withdrawals_fee_less_than_amount_check/);
  });

  it("enforces uniqueness of (userId, clientWithdrawalId) at the database level (Phase 9 hardening)", async () => {
    const user = await createTestUser();
    const assetNetwork = await getAssetNetwork("USDC", "ethereum-sepolia");
    const clientWithdrawalId = "dup-ck-" + Date.now();

    await prisma.withdrawal.create({
      data: { userId: user.id, assetNetworkId: assetNetwork.id, destinationAddress: "0x000000000000000000000000000000000000dEaD", amount: "10", clientWithdrawalId },
    });

    // Matches this file's own established pattern for unique-constraint
    // assertions (see "enforces the idempotencyKey uniqueness on
    // ledger_transactions") — a plain Prisma Client P2002, not a raw-SQL
    // message regex, which for a unique (as opposed to CHECK) violation
    // doesn't surface the constraint name in the same way.
    await expect(
      prisma.withdrawal.create({
        data: { userId: user.id, assetNetworkId: assetNetwork.id, destinationAddress: "0x000000000000000000000000000000000000dEaD", amount: "20", clientWithdrawalId },
      }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
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
    const outcome = await prisma.marketOutcome.create({ data: { marketId: market.id, key: "YES", label: "YES" } });

    await expect(
      prisma.$executeRaw`
        INSERT INTO "orders" ("id", "userId", "marketId", "outcomeId", "side", "type", "quantity", "filledQuantity", "remainingQuantity", "clientOrderId", "status", "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::text, ${user.id}, ${market.id}, ${outcome.id}, 'BUY', 'MARKET', 0, 0, 0, ${"legacy-check-" + Date.now()}, 'OPEN', NOW(), NOW())
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
