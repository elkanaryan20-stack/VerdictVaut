import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { InsufficientBalanceError } from "./ledger.errors";
import { LedgerService } from "./ledger.service";

describe("LedgerService", () => {
  let service: LedgerService;
  let prisma: {
    asset: { findUniqueOrThrow: jest.Mock };
    ledgerAccount: { upsert: jest.Mock; update: jest.Mock };
    ledgerEntry: { create: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      asset: { findUniqueOrThrow: jest.fn() },
      ledgerAccount: { upsert: jest.fn(), update: jest.fn() },
      ledgerEntry: { create: jest.fn() },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [LedgerService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(LedgerService);
  });

  it("credits an account and persists the new cached balance", async () => {
    prisma.asset.findUniqueOrThrow.mockResolvedValue({ id: "asset-1", symbol: "USDC" });
    prisma.ledgerAccount.upsert.mockResolvedValue({ id: "acct-1", cachedBalance: new Prisma.Decimal(100) });
    prisma.ledgerEntry.create.mockImplementation(async ({ data }) => ({ id: "entry-1", ...data }));

    const entry = await service.postEntry({
      userId: "user-1",
      assetSymbol: "USDC",
      amount: "50",
      type: "DEPOSIT",
      referenceType: "Deposit",
      referenceId: "dep-1",
    });

    expect((entry.balanceAfter as Prisma.Decimal).toString()).toBe("150");
    expect(prisma.ledgerAccount.update).toHaveBeenCalledWith({
      where: { id: "acct-1" },
      data: { cachedBalance: expect.anything() },
    });
  });

  it("throws InsufficientBalanceError instead of allowing a negative balance", async () => {
    prisma.asset.findUniqueOrThrow.mockResolvedValue({ id: "asset-1", symbol: "USDC" });
    prisma.ledgerAccount.upsert.mockResolvedValue({ id: "acct-1", cachedBalance: new Prisma.Decimal(10) });

    await expect(
      service.postEntry({
        userId: "user-1",
        assetSymbol: "USDC",
        amount: "-50",
        type: "WITHDRAWAL_HOLD",
        referenceType: "Withdrawal",
        referenceId: "wd-1",
      }),
    ).rejects.toThrow(InsufficientBalanceError);

    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.ledgerAccount.update).not.toHaveBeenCalled();
  });

  it("allows a debit that exactly zeroes the balance", async () => {
    prisma.asset.findUniqueOrThrow.mockResolvedValue({ id: "asset-1", symbol: "USDC" });
    prisma.ledgerAccount.upsert.mockResolvedValue({ id: "acct-1", cachedBalance: new Prisma.Decimal(50) });
    prisma.ledgerEntry.create.mockImplementation(async ({ data }) => ({ id: "entry-2", ...data }));

    const entry = await service.postEntry({
      userId: "user-1",
      assetSymbol: "USDC",
      amount: "-50",
      type: "WITHDRAWAL",
      referenceType: "Withdrawal",
      referenceId: "wd-2",
    });

    expect((entry.balanceAfter as Prisma.Decimal).toString()).toBe("0");
  });
});
