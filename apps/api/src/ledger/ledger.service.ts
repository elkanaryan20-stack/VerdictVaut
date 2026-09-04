import { Injectable } from "@nestjs/common";
import { HouseAccountKey, LedgerAccount, LedgerTransactionType, Prisma } from "@prisma/client";
import { createIdempotent } from "../prisma/idempotent-create.util";
import { PrismaService } from "../prisma/prisma.service";
import { computeAvailableBalance, computeBalanceAfter, isNegative, sumAmounts } from "./balance.util";
import { InsufficientBalanceError, UnbalancedTransactionError } from "./ledger.errors";

export type AccountRef = { type: "USER"; userId: string } | { type: "HOUSE"; key: HouseAccountKey };

export interface PostTransactionInput {
  assetSymbol: string;
  type: LedgerTransactionType;
  referenceType: string;
  referenceId: string;
  /** Globally unique — this, not application control flow, is what guarantees "posted at most once". */
  idempotencyKey: string;
  /** Must sum to zero. At least two legs — every credit needs a counterparty debit. */
  postings: Array<{ account: AccountRef; amount: Prisma.Decimal.Value }>;
}

export interface PostTransactionResult {
  transactionId: string;
  alreadyPosted: boolean;
}

/**
 * True double-entry ledger. Every financial mutation is a
 * LedgerTransaction whose postings (LedgerEntry rows) sum to zero for its
 * asset — a user account is always debited/credited against a
 * counterparty (another user, or a HOUSE account such as EXTERNAL_CHAIN
 * standing in for the outside blockchain, or FEE_REVENUE).
 *
 * `postTransaction` takes the caller's own transaction client rather than
 * opening one itself — every caller must obtain that client from
 * SerializableTransactionRunner, so there is exactly one way to reach this
 * method and it is always SERIALIZABLE. Idempotency is enforced by the
 * unique constraint on `idempotencyKey`: a repeat call with the same key
 * (retry, duplicate webhook, double-click) is detected and returned as
 * `alreadyPosted: true` rather than posting a second time.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async getBalance(userId: string, assetSymbol: string): Promise<Prisma.Decimal> {
    const account = await this.findUserAccount(userId, assetSymbol);
    return account?.cachedBalance ?? new Prisma.Decimal(0);
  }

  async getAvailableBalance(userId: string, assetSymbol: string): Promise<Prisma.Decimal> {
    const account = await this.findUserAccount(userId, assetSymbol);
    if (!account) return new Prisma.Decimal(0);
    return computeAvailableBalance(account.cachedBalance, account.reservedBalance);
  }

  private async findUserAccount(userId: string, assetSymbol: string) {
    const asset = await this.prisma.asset.findUniqueOrThrow({ where: { symbol: assetSymbol } });
    return this.prisma.ledgerAccount.findUnique({ where: { userId_assetId: { userId, assetId: asset.id } } });
  }

  async postTransaction(tx: Prisma.TransactionClient, input: PostTransactionInput): Promise<PostTransactionResult> {
    if (input.postings.length < 2) {
      throw new UnbalancedTransactionError("n/a", "a transaction needs at least two postings");
    }

    const asset = await tx.asset.findUniqueOrThrow({ where: { symbol: input.assetSymbol } });

    const amounts = input.postings.map((p) => new Prisma.Decimal(p.amount));
    const total = sumAmounts(amounts);
    if (!total.isZero()) {
      throw new UnbalancedTransactionError(asset.id, total.toString());
    }

    const { row: transaction, alreadyExisted } = await createIdempotent(
      tx,
      "idempotencyKey",
      () =>
        tx.ledgerTransaction.create({
          data: {
            assetId: asset.id,
            type: input.type,
            referenceType: input.referenceType,
            referenceId: input.referenceId,
            idempotencyKey: input.idempotencyKey,
          },
        }),
      () => tx.ledgerTransaction.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } }),
    );

    if (alreadyExisted) {
      return { transactionId: transaction.id, alreadyPosted: true };
    }
    const transactionId = transaction.id;

    for (let i = 0; i < input.postings.length; i += 1) {
      const posting = input.postings[i];
      const amount = amounts[i];
      const account = await this.resolveAccount(tx, asset.id, posting.account);

      const balanceAfter = computeBalanceAfter(account.cachedBalance, amount);
      if (account.ownerType === "USER" && isNegative(balanceAfter)) {
        throw new InsufficientBalanceError(account.id, account.cachedBalance.toString(), amount.toString());
      }

      await tx.ledgerEntry.create({
        data: { transactionId, accountId: account.id, amount, balanceAfter },
      });

      await tx.ledgerAccount.update({
        where: { id: account.id },
        data: { cachedBalance: balanceAfter },
      });
    }

    return { transactionId, alreadyPosted: false };
  }

  async resolveAccount(tx: Prisma.TransactionClient, assetId: string, ref: AccountRef): Promise<LedgerAccount> {
    if (ref.type === "USER") {
      return tx.ledgerAccount.upsert({
        where: { userId_assetId: { userId: ref.userId, assetId } },
        create: { ownerType: "USER", userId: ref.userId, assetId, cachedBalance: 0, reservedBalance: 0 },
        update: {},
      });
    }

    return tx.ledgerAccount.upsert({
      where: { houseAccountKey_assetId: { houseAccountKey: ref.key, assetId } },
      create: { ownerType: "HOUSE", houseAccountKey: ref.key, assetId, cachedBalance: 0, reservedBalance: 0 },
      update: {},
    });
  }
}
