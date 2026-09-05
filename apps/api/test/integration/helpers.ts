/* eslint-disable @typescript-eslint/no-var-requires */
const pgConfig = require("./pg-config");

// Must be set before PrismaService is constructed — Prisma reads
// DATABASE_URL from the environment at client-construction time.
process.env.DATABASE_URL = pgConfig.databaseUrl;

import { Prisma } from "@prisma/client";
import { AuditLogService } from "../../src/audit/audit-log.service";
import { LedgerService } from "../../src/ledger/ledger.service";
import { ReservationService } from "../../src/ledger/reservation.service";
import { MarketsService } from "../../src/markets/markets.service";
import { PrismaService } from "../../src/prisma/prisma.service";
import { SerializableTransactionRunner } from "../../src/prisma/serializable-transaction-runner";
import { ExecutionCoordinator } from "../../src/trading/execution/execution-coordinator.service";
import { ZeroFeeCalculator } from "../../src/trading/fees/zero-fee.calculator";
import { PriceTimePriorityMatchingEngine } from "../../src/trading/matching/price-time-priority-matching-engine";
import { OrderBookService } from "../../src/trading/order-book/order-book.service";
import { OrdersService } from "../../src/trading/orders.service";
import { PositionReservationService } from "../../src/trading/positions/position-reservation.service";
import { PositionsService } from "../../src/trading/positions/positions.service";
import { OrderRiskValidator } from "../../src/trading/risk/order-risk-validator.service";
import { ResolutionService } from "../../src/markets/resolution/resolution.service";
import { SettlementService } from "../../src/settlement/settlement.service";
import { DepositAddressService } from "../../src/wallet/addresses/deposit-address.service";
import { DepositsService } from "../../src/wallet/deposits/deposits.service";
import { ManualBroadcastExecutor } from "../../src/wallet/executors/manual-broadcast.executor";
import { ProductionCustodyExecutor } from "../../src/wallet/executors/production-custody.executor";
import { WithdrawalExecutorFactory } from "../../src/wallet/executors/withdrawal-executor.factory";
import { WithdrawalsService } from "../../src/wallet/withdrawals/withdrawals.service";

export const prisma = new PrismaService();
export const txRunner = new SerializableTransactionRunner(prisma);
export const ledger = new LedgerService(prisma);
export const reservations = new ReservationService(prisma);
export const auditLog = new AuditLogService(prisma);
export const depositsService = new DepositsService(prisma, ledger, txRunner, auditLog);
export const depositAddressService = new DepositAddressService(prisma, txRunner);

const manualBroadcastExecutor = new ManualBroadcastExecutor();
const productionCustodyExecutor = new ProductionCustodyExecutor();
export const executorFactory = new WithdrawalExecutorFactory(prisma, manualBroadcastExecutor, productionCustodyExecutor);
export const withdrawalsService = new WithdrawalsService(prisma, ledger, reservations, executorFactory, txRunner, auditLog);

export const positionReservations = new PositionReservationService(prisma);
export const positionsService = new PositionsService(prisma);
export const orderRiskValidator = new OrderRiskValidator(prisma);
export const feeCalculator = new ZeroFeeCalculator();
export const orderBookService = new OrderBookService(prisma);
export const matchingEngine = new PriceTimePriorityMatchingEngine();
export const executionCoordinator = new ExecutionCoordinator(
  prisma,
  txRunner,
  orderBookService,
  ledger,
  reservations,
  positionReservations,
  matchingEngine,
  feeCalculator,
);
export const ordersService = new OrdersService(
  prisma,
  reservations,
  positionReservations,
  orderRiskValidator,
  feeCalculator,
  txRunner,
  executionCoordinator,
);
export const settlementService = new SettlementService(prisma, txRunner, ledger);
export const resolutionService = new ResolutionService(prisma, txRunner, auditLog, settlementService);
export const marketsService = new MarketsService(prisma, txRunner, auditLog, ordersService);

let userCounter = 0;

export async function createTestUser(
  status: "ACTIVE" | "PENDING_VERIFICATION" | "SUSPENDED" = "ACTIVE",
  role: "USER" | "RISK_OPS" | "ADMIN" | "SUPER_ADMIN" = "USER",
) {
  userCounter += 1;
  return prisma.user.create({
    data: {
      email: `test-${Date.now()}-${userCounter}-${Math.random().toString(36).slice(2)}@example.com`,
      passwordHash: "unused-in-tests",
      status,
      role,
    },
  });
}

export async function createTestAdmin() {
  return createTestUser("ACTIVE", "ADMIN");
}

export async function getAsset(symbol: string) {
  return prisma.asset.findUniqueOrThrow({ where: { symbol } });
}

export async function getNetwork(code: string) {
  return prisma.network.findUniqueOrThrow({ where: { code } });
}

export async function getAssetNetwork(assetSymbol: string, networkCode: string) {
  const [asset, network] = await Promise.all([getAsset(assetSymbol), getNetwork(networkCode)]);
  return prisma.assetNetwork.findUniqueOrThrow({
    where: { assetId_networkId: { assetId: asset.id, networkId: network.id } },
  });
}

export async function provisionAddress(
  assetNetworkId: string,
  address: string,
  environment: "SANDBOX" | "PRODUCTION" = "SANDBOX",
) {
  return prisma.walletAddress.create({ data: { assetNetworkId, address, environment, status: "AVAILABLE" } });
}

/**
 * Test-fixture helper only (lives under test/integration, never shipped)
 * — funds a user's ledger account by going through the real
 * LedgerService.postTransaction posting path, exactly as a genuine
 * deposit credit would, rather than writing cachedBalance directly. This
 * sets up preconditions for withdrawal/ordering tests without bypassing
 * or faking the accounting logic under test.
 */
export async function fundUserForTest(userId: string, assetSymbol: string, amount: string) {
  const unique = `${userId}:${assetSymbol}:${Date.now()}:${Math.random()}`;
  return txRunner.run((tx) =>
    ledger.postTransaction(tx, {
      assetSymbol,
      type: "DEPOSIT",
      referenceType: "TestFixture",
      referenceId: unique,
      idempotencyKey: `fixture:${unique}`,
      postings: [
        { account: { type: "USER", userId }, amount },
        { account: { type: "HOUSE", key: "EXTERNAL_CHAIN" }, amount: new Prisma.Decimal(amount).negated() },
      ],
    }),
  );
}

export async function getUserAccount(userId: string, assetSymbol: string) {
  const asset = await getAsset(assetSymbol);
  return prisma.ledgerAccount.findUnique({ where: { userId_assetId: { userId, assetId: asset.id } } });
}

/**
 * Test-fixture helper only. There is no real position-crediting mechanism
 * in this phase — that is the (not-yet-built) matching engine's job — so
 * this directly sets a Position's quantity via Prisma to test SELL-order
 * share-reservation without a matcher. This never runs in the shipped
 * app and never represents fabricated real trading activity; it exists
 * solely so PositionReservationService can be exercised deterministically.
 */
export async function grantPositionForTest(userId: string, marketId: string, outcomeId: string, quantity: string) {
  return prisma.position.upsert({
    where: { userId_marketId_outcomeId: { userId, marketId, outcomeId } },
    create: { userId, marketId, outcomeId, quantity: new Prisma.Decimal(quantity), reservedQuantity: 0 },
    update: { quantity: new Prisma.Decimal(quantity) },
  });
}

let marketCounter = 0;

/**
 * Creates a real DRAFT market with two outcomes (YES/NO by default) via
 * the actual MarketsService, plus a fresh category (categories aren't
 * seeded). Does not open it — call openMarketForTest for that.
 */
export async function createTestMarket(adminId: string, overrides: { closeTime?: string; maxExposure?: string } = {}) {
  marketCounter += 1;
  const marker = `${Date.now()}-${marketCounter}-${Math.random().toString(36).slice(2)}`;
  const category = await prisma.marketCategory.create({
    data: { slug: `test-cat-${marker}`, name: "Test Category" },
  });

  const market = await marketsService.create(
    {
      slug: `test-market-${marker}`,
      title: "Test Market",
      description: "A test market",
      categorySlug: category.slug,
      closeTime: overrides.closeTime,
      outcomes: [
        { key: "YES", label: "Yes" },
        { key: "NO", label: "No" },
      ],
    },
    adminId,
  );

  if (overrides.maxExposure) {
    await prisma.market.update({ where: { id: market.id }, data: { maxExposure: new Prisma.Decimal(overrides.maxExposure) } });
  }

  const yes = market.outcomes.find((o) => o.key === "YES")!;
  const no = market.outcomes.find((o) => o.key === "NO")!;
  return { market, yes, no };
}

export async function openMarketForTest(marketId: string, adminId: string) {
  return marketsService.open(marketId, adminId);
}
