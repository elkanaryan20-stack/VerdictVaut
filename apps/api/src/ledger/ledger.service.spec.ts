import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { InsufficientBalanceError, UnbalancedTransactionError } from "./ledger.errors";
import { LedgerService } from "./ledger.service";

function makeIdempotencyConflict() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
    meta: { target: ["idempotencyKey"] },
  });
}

describe("LedgerService", () => {
  let service: LedgerService;
  let tx: {
    asset: { findUniqueOrThrow: jest.Mock };
    ledgerTransaction: { create: jest.Mock; findUniqueOrThrow: jest.Mock };
    ledgerAccount: { upsert: jest.Mock; update: jest.Mock };
    ledgerEntry: { create: jest.Mock };
    $executeRawUnsafe: jest.Mock;
  };

  const asset = { id: "asset-usdc", symbol: "USDC" };

  beforeEach(() => {
    tx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
      asset: { findUniqueOrThrow: jest.fn().mockResolvedValue(asset) },
      ledgerTransaction: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: "txn-1", ...data })),
        findUniqueOrThrow: jest.fn(),
      },
      ledgerAccount: {
        upsert: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      ledgerEntry: { create: jest.fn().mockResolvedValue({}) },
    };
    service = new LedgerService({} as PrismaService);
  });

  const userAccount = (balance: string, reserved = "0") => ({
    id: "acct-user",
    ownerType: "USER",
    cachedBalance: new Prisma.Decimal(balance),
    reservedBalance: new Prisma.Decimal(reserved),
  });

  const houseAccount = (balance: string) => ({
    id: "acct-house",
    ownerType: "HOUSE",
    cachedBalance: new Prisma.Decimal(balance),
    reservedBalance: new Prisma.Decimal(0),
  });

  it("posts a balanced two-leg transaction and updates both accounts", async () => {
    tx.ledgerAccount.upsert.mockResolvedValueOnce(userAccount("0")).mockResolvedValueOnce(houseAccount("0"));

    const result = await service.postTransaction(tx as never, {
      assetSymbol: "USDC",
      type: "DEPOSIT",
      referenceType: "Deposit",
      referenceId: "dep-1",
      idempotencyKey: "deposit:dep-1",
      postings: [
        { account: { type: "USER", userId: "user-1" }, amount: "100" },
        { account: { type: "HOUSE", key: "EXTERNAL_CHAIN" }, amount: "-100" },
      ],
    });

    expect(result.alreadyPosted).toBe(false);
    expect(tx.ledgerEntry.create).toHaveBeenCalledTimes(2);
    expect(tx.ledgerAccount.update).toHaveBeenNthCalledWith(1, {
      where: { id: "acct-user" },
      data: { cachedBalance: expect.anything() },
    });
    const userUpdateBalance = tx.ledgerAccount.update.mock.calls[0][0].data.cachedBalance as Prisma.Decimal;
    expect(userUpdateBalance.toString()).toBe("100");
    const houseUpdateBalance = tx.ledgerAccount.update.mock.calls[1][0].data.cachedBalance as Prisma.Decimal;
    expect(houseUpdateBalance.toString()).toBe("-100");
  });

  it("rejects postings that do not sum to zero", async () => {
    await expect(
      service.postTransaction(tx as never, {
        assetSymbol: "USDC",
        type: "ADJUSTMENT",
        referenceType: "Test",
        referenceId: "t-1",
        idempotencyKey: "t-1",
        postings: [
          { account: { type: "USER", userId: "user-1" }, amount: "100" },
          { account: { type: "HOUSE", key: "EXTERNAL_CHAIN" }, amount: "-99" },
        ],
      }),
    ).rejects.toThrow(UnbalancedTransactionError);

    expect(tx.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it("requires at least two postings", async () => {
    await expect(
      service.postTransaction(tx as never, {
        assetSymbol: "USDC",
        type: "ADJUSTMENT",
        referenceType: "Test",
        referenceId: "t-2",
        idempotencyKey: "t-2",
        postings: [{ account: { type: "USER", userId: "user-1" }, amount: "0" }],
      }),
    ).rejects.toThrow(UnbalancedTransactionError);
  });

  it("throws InsufficientBalanceError instead of letting a USER account go negative", async () => {
    tx.ledgerAccount.upsert.mockResolvedValueOnce(userAccount("10")).mockResolvedValueOnce(houseAccount("0"));

    await expect(
      service.postTransaction(tx as never, {
        assetSymbol: "USDC",
        type: "WITHDRAWAL",
        referenceType: "Withdrawal",
        referenceId: "wd-1",
        idempotencyKey: "withdrawal-capture:wd-1",
        postings: [
          { account: { type: "USER", userId: "user-1" }, amount: "-50" },
          { account: { type: "HOUSE", key: "EXTERNAL_CHAIN" }, amount: "50" },
        ],
      }),
    ).rejects.toThrow(InsufficientBalanceError);
  });

  it("allows a HOUSE account to go negative (EXTERNAL_CHAIN mirrors the outside chain)", async () => {
    tx.ledgerAccount.upsert.mockResolvedValueOnce(userAccount("0")).mockResolvedValueOnce(houseAccount("0"));

    const result = await service.postTransaction(tx as never, {
      assetSymbol: "USDC",
      type: "DEPOSIT",
      referenceType: "Deposit",
      referenceId: "dep-2",
      idempotencyKey: "deposit:dep-2",
      postings: [
        { account: { type: "USER", userId: "user-1" }, amount: "500" },
        { account: { type: "HOUSE", key: "EXTERNAL_CHAIN" }, amount: "-500" },
      ],
    });

    expect(result.alreadyPosted).toBe(false);
  });

  it("treats a repeat idempotencyKey as an already-posted no-op, not a duplicate credit", async () => {
    tx.ledgerTransaction.create.mockRejectedValueOnce(makeIdempotencyConflict());
    tx.ledgerTransaction.findUniqueOrThrow.mockResolvedValueOnce({ id: "txn-existing" });

    const result = await service.postTransaction(tx as never, {
      assetSymbol: "USDC",
      type: "DEPOSIT",
      referenceType: "Deposit",
      referenceId: "dep-3",
      idempotencyKey: "deposit:dep-3",
      postings: [
        { account: { type: "USER", userId: "user-1" }, amount: "100" },
        { account: { type: "HOUSE", key: "EXTERNAL_CHAIN" }, amount: "-100" },
      ],
    });

    expect(result).toEqual({ transactionId: "txn-existing", alreadyPosted: true });
    // Never reached postings — no account was ever touched a second time.
    expect(tx.ledgerAccount.upsert).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });
});
