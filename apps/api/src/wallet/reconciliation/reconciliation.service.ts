import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DepositStatus, Prisma, ReconciliationStatus, WalletAddressStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { CustodyProviderFactory } from "../custody/custody-provider.factory";

interface AddressDiscrepancy {
  walletAddressId: string;
  address: string;
  chainBalance: string;
  internalCreditedTotal: string;
  difference: string;
}

interface AddressError {
  walletAddressId: string;
  address: string;
  error: string;
}

const RECONCILIATION_TOLERANCE = new Prisma.Decimal("0.000000000000000001"); // 1 base unit at 18 decimals — pure floating/rounding slack, not a real discrepancy allowance

/**
 * Compares real on-chain balance (via CustodyProvider — never a cached
 * figure) against this platform's own record of what it believes it has
 * credited for that address (the sum of CREDITED Deposit rows — NOT
 * LedgerAccount.cachedBalance, which is a per-user total across every
 * address/asset and would defeat the point of an address-level check).
 * This is deliberately a narrow, honest data/model boundary — a full
 * reconciliation platform (historical trend tracking, auto-remediation,
 * alerting) is out of scope for this phase.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providerFactory: CustodyProviderFactory,
  ) {}

  async run(assetNetworkId: string) {
    const assetNetwork = await this.prisma.assetNetwork.findUnique({ where: { id: assetNetworkId } });
    if (!assetNetwork) {
      throw new NotFoundException("Asset/network pair not found");
    }

    const addresses = await this.prisma.walletAddress.findMany({
      where: { assetNetworkId, status: WalletAddressStatus.ASSIGNED },
    });

    if (addresses.length === 0) {
      return this.prisma.reconciliationRun.create({
        data: { assetNetworkId, status: ReconciliationStatus.OK, notes: "No assigned deposit addresses for this asset/network yet." },
      });
    }

    const provider = await this.providerFactory.resolve(assetNetworkId);
    const discrepancies: AddressDiscrepancy[] = [];
    const errors: AddressError[] = [];

    for (const address of addresses) {
      try {
        const [chainBalance, internalTotal] = await Promise.all([
          provider.getAddressBalance(address.address, assetNetworkId),
          this.sumCreditedDeposits(address.id),
        ]);

        const difference = new Prisma.Decimal(chainBalance.balance).minus(internalTotal).abs();
        if (difference.greaterThan(RECONCILIATION_TOLERANCE)) {
          discrepancies.push({
            walletAddressId: address.id,
            address: address.address,
            chainBalance: chainBalance.balance,
            internalCreditedTotal: internalTotal.toString(),
            difference: difference.toString(),
          });
        }
      } catch (error) {
        this.logger.error(`Reconciliation chain lookup failed for address ${address.address}`, error as Error);
        errors.push({ walletAddressId: address.id, address: address.address, error: (error as Error).message });
      }
    }

    const status =
      errors.length > 0 ? ReconciliationStatus.ERROR : discrepancies.length > 0 ? ReconciliationStatus.DISCREPANCY_FOUND : ReconciliationStatus.OK;

    return this.prisma.reconciliationRun.create({
      data: {
        assetNetworkId,
        status,
        discrepancies: { discrepancies, errors } as unknown as Prisma.InputJsonValue,
        notes: `Checked ${addresses.length} address(es): ${discrepancies.length} discrepancy(ies), ${errors.length} lookup error(s).`,
      },
    });
  }

  private async sumCreditedDeposits(walletAddressId: string): Promise<Prisma.Decimal> {
    const result = await this.prisma.deposit.aggregate({
      where: { walletAddressId, status: DepositStatus.CREDITED },
      _sum: { amount: true },
    });
    return result._sum.amount ?? new Prisma.Decimal(0);
  }

  async listRuns(assetNetworkId: string) {
    return this.prisma.reconciliationRun.findMany({
      where: { assetNetworkId },
      orderBy: { runAt: "desc" },
      take: 50,
    });
  }
}
