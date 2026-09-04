/* eslint-disable @typescript-eslint/no-var-requires */
const pgConfig = require("./pg-config");

// Must be set before PrismaService is constructed — Prisma reads
// DATABASE_URL from the environment at client-construction time.
process.env.DATABASE_URL = pgConfig.databaseUrl;

import { Prisma } from "@prisma/client";
import { AuditLogService } from "../../src/audit/audit-log.service";
import { LedgerService } from "../../src/ledger/ledger.service";
import { ReservationService } from "../../src/ledger/reservation.service";
import { PrismaService } from "../../src/prisma/prisma.service";
import { SerializableTransactionRunner } from "../../src/prisma/serializable-transaction-runner";
import { OrdersService } from "../../src/trading/orders.service";
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
export const ordersService = new OrdersService(prisma, reservations, txRunner);

const manualBroadcastExecutor = new ManualBroadcastExecutor();
const productionCustodyExecutor = new ProductionCustodyExecutor();
export const executorFactory = new WithdrawalExecutorFactory(prisma, manualBroadcastExecutor, productionCustodyExecutor);
export const withdrawalsService = new WithdrawalsService(prisma, ledger, reservations, executorFactory, txRunner, auditLog);

let userCounter = 0;

export async function createTestUser(status: "ACTIVE" | "PENDING_VERIFICATION" | "SUSPENDED" = "ACTIVE") {
  userCounter += 1;
  return prisma.user.create({
    data: {
      email: `test-${Date.now()}-${userCounter}-${Math.random().toString(36).slice(2)}@example.com`,
      passwordHash: "unused-in-tests",
      status,
    },
  });
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
