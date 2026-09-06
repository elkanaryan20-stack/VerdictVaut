import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { computeAvailableBalance } from "../../ledger/balance.util";
import { PrismaService } from "../../prisma/prisma.service";

export interface AssetBalanceView {
  assetId: string;
  symbol: string;
  name: string;
  decimals: number;
  assetClass: string;
  totalBalance: string;
  reservedBalance: string;
  availableBalance: string;
}

/**
 * Read-only wallet balance view — one row per active asset, always
 * present even when the user has never touched that asset (zero-filled,
 * matching LedgerService.getBalance's own "no account yet = 0" contract,
 * never a fabricated figure). Never mutates anything: this exists purely
 * to give the frontend a single call instead of one LedgerService lookup
 * per asset. Balances across different assets are deliberately never
 * summed into one blended total — there is no price/FX conversion
 * anywhere in this system, so "total" here always means one asset's own
 * total, never a portfolio-wide figure.
 */
@Injectable()
export class BalancesService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyBalances(userId: string): Promise<AssetBalanceView[]> {
    const [assets, accounts] = await Promise.all([
      this.prisma.asset.findMany({ where: { isActive: true }, orderBy: { symbol: "asc" } }),
      this.prisma.ledgerAccount.findMany({ where: { userId, ownerType: "USER" } }),
    ]);

    const accountByAssetId = new Map(accounts.map((account) => [account.assetId, account]));

    return assets.map((asset) => {
      const account = accountByAssetId.get(asset.id);
      const cachedBalance = account?.cachedBalance ?? new Prisma.Decimal(0);
      const reservedBalance = account?.reservedBalance ?? new Prisma.Decimal(0);

      return {
        assetId: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        decimals: asset.decimals,
        assetClass: asset.assetClass,
        totalBalance: cachedBalance.toString(),
        reservedBalance: reservedBalance.toString(),
        availableBalance: computeAvailableBalance(cachedBalance, reservedBalance).toString(),
      };
    });
  }
}
