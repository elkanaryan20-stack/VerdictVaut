import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { BalancesService } from "./balances.service";

describe("BalancesService", () => {
  let prisma: { asset: { findMany: jest.Mock }; ledgerAccount: { findMany: jest.Mock } };
  let service: BalancesService;

  const assets = [
    { id: "asset-btc", symbol: "BTC", name: "Bitcoin", decimals: 8, assetClass: "NATIVE", isActive: true },
    { id: "asset-usdc", symbol: "USDC", name: "USD Coin", decimals: 6, assetClass: "TOKEN", isActive: true },
  ];

  beforeEach(() => {
    prisma = {
      asset: { findMany: jest.fn().mockResolvedValue(assets) },
      ledgerAccount: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new BalancesService(prisma as unknown as PrismaService);
  });

  it("returns every active asset, even ones the user has never touched", async () => {
    const balances = await service.getMyBalances("user-1");
    expect(balances).toHaveLength(2);
    expect(balances.map((b) => b.symbol)).toEqual(["BTC", "USDC"]);
  });

  it("zero-fills total/reserved/available for an asset with no LedgerAccount row — never fabricates a balance", async () => {
    const balances = await service.getMyBalances("user-1");
    const btc = balances.find((b) => b.symbol === "BTC")!;
    expect(btc.totalBalance).toBe("0");
    expect(btc.reservedBalance).toBe("0");
    expect(btc.availableBalance).toBe("0");
  });

  it("reflects the real LedgerAccount figures when one exists", async () => {
    prisma.ledgerAccount.findMany.mockResolvedValue([
      { assetId: "asset-usdc", cachedBalance: new Prisma.Decimal("100"), reservedBalance: new Prisma.Decimal("30") },
    ]);
    const balances = await service.getMyBalances("user-1");
    const usdc = balances.find((b) => b.symbol === "USDC")!;
    expect(usdc.totalBalance).toBe("100");
    expect(usdc.reservedBalance).toBe("30");
    expect(usdc.availableBalance).toBe("70");
  });

  it("never represents reserved funds as available — available is always total minus reserved", async () => {
    prisma.ledgerAccount.findMany.mockResolvedValue([
      { assetId: "asset-btc", cachedBalance: new Prisma.Decimal("5"), reservedBalance: new Prisma.Decimal("5") },
    ]);
    const balances = await service.getMyBalances("user-1");
    const btc = balances.find((b) => b.symbol === "BTC")!;
    expect(btc.availableBalance).toBe("0");
  });

  it("only queries the requesting user's own ledger accounts", async () => {
    await service.getMyBalances("user-42");
    expect(prisma.ledgerAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-42", ownerType: "USER" } }),
    );
  });
});
