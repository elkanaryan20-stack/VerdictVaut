import { Injectable } from "@nestjs/common";
import { LedgerEntryType, Prisma, PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { computeBalanceAfter, isNegative } from "./balance.util";
import { InsufficientBalanceError } from "./ledger.errors";

export interface PostLedgerEntryInput {
  userId: string;
  assetSymbol: string;
  /** Signed amount — positive credits the account, negative debits it. */
  amount: Prisma.Decimal.Value;
  type: LedgerEntryType;
  referenceType: string;
  referenceId: string;
}

/**
 * The single authoritative path for mutating a user's balance. Every
 * financial mutation in the system (deposits, withdrawals, trades, fees,
 * settlements) must go through postEntry — there is no other write path
 * to LedgerAccount.cachedBalance, and callers never write it directly.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(userId: string, assetSymbol: string): Promise<Prisma.Decimal> {
    const asset = await this.prisma.asset.findUniqueOrThrow({ where: { symbol: assetSymbol } });
    const account = await this.prisma.ledgerAccount.findUnique({
      where: { userId_assetId: { userId, assetId: asset.id } },
    });
    return account?.cachedBalance ?? new Prisma.Decimal(0);
  }

  /**
   * Posts a single signed ledger entry and updates the account's cached
   * balance atomically. Throws InsufficientBalanceError rather than letting
   * a balance go negative. Runs at SERIALIZABLE isolation so concurrent
   * mutations to the same account cannot race; callers should be prepared
   * to retry on a serialization failure.
   */
  async postEntry(input: PostLedgerEntryInput, client: PrismaTransactionClient = this.prisma) {
    const amount = new Prisma.Decimal(input.amount);
    const asset = await client.asset.findUniqueOrThrow({ where: { symbol: input.assetSymbol } });

    const run = async (tx: PrismaTransactionClient) => {
      const account = await tx.ledgerAccount.upsert({
        where: { userId_assetId: { userId: input.userId, assetId: asset.id } },
        create: { userId: input.userId, assetId: asset.id, cachedBalance: 0 },
        update: {},
      });

      const balanceAfter = computeBalanceAfter(account.cachedBalance, amount);
      if (isNegative(balanceAfter)) {
        throw new InsufficientBalanceError(account.id, account.cachedBalance.toString(), amount.toString());
      }

      const entry = await tx.ledgerEntry.create({
        data: {
          accountId: account.id,
          amount,
          type: input.type,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          balanceAfter,
        },
      });

      await tx.ledgerAccount.update({
        where: { id: account.id },
        data: { cachedBalance: balanceAfter },
      });

      return entry;
    };

    if (client === this.prisma) {
      return this.prisma.$transaction(run, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }
    // Already inside an outer transaction (e.g. withdrawal state transition) — reuse it.
    return run(client);
  }
}

export type PrismaTransactionClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
