import { WalletAddressStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { WatchedAddress } from "./deposit-chain-adapter.interface";

export interface WatchedAddressWithOwner extends WatchedAddress {
  userId: string;
}

/**
 * Every currently-assigned deposit address for one asset/network, plus
 * the user each belongs to — shared by DepositWatcherService (the normal
 * cursor-based scanner) and IndependentReconciliationService (Phase 12A
 * — deliberately reuses this same address set, since "which addresses do
 * we watch" is not itself part of what independence from the watcher
 * cursor means; only the scan cursor/window must be independently
 * derived, never this).
 */
export async function loadWatchedAddresses(prisma: PrismaService, assetNetworkId: string): Promise<WatchedAddressWithOwner[]> {
  const rows = await prisma.walletAddress.findMany({
    where: { assetNetworkId, status: WalletAddressStatus.ASSIGNED },
    include: { assignment: true },
  });

  return rows
    .filter((row) => row.assignment != null)
    .map((row) => ({
      walletAddressId: row.id,
      address: row.address,
      destinationTag: row.destinationTag,
      userId: row.assignment!.userId,
    }));
}
