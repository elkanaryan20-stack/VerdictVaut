import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WalletAddressStatus } from "@prisma/client";
import { AppConfig } from "../../config/configuration";
import { PrismaService } from "../../prisma/prisma.service";
import { DepositChainAdapterFactory } from "../chain-adapters/deposit-chain-adapter.factory";
import { WatchedAddress } from "../chain-adapters/deposit-chain-adapter.interface";
import { ConfirmationPolicyService } from "../confirmation/confirmation-policy.service";
import { DepositsService } from "../deposits/deposits.service";

interface WatchedAddressWithOwner extends WatchedAddress {
  userId: string;
}

/**
 * The one place that turns "poll every active asset/network's pool
 * addresses" into calls against DepositsService.recordObservedTransaction
 * — it never touches LedgerAccount, LedgerEntry, or Deposit.status
 * itself (see the module doc: "the watcher must never directly mutate
 * balances"). All chain I/O happens here, outside of any DB transaction —
 * SerializableTransactionRunner's contract explicitly forbids external
 * side effects inside `fn`, and DepositsService already owns the only
 * transactional boundary that matters.
 *
 * Off by default (CHAIN_WATCHER_ENABLED) so importing this module never
 * causes an app instance — including every unit and integration test —
 * to start making outbound network calls on its own.
 */
@Injectable()
export class DepositWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DepositWatcherService.name);
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapterFactory: DepositChainAdapterFactory,
    private readonly confirmationPolicy: ConfirmationPolicyService,
    private readonly depositsService: DepositsService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  onModuleInit(): void {
    const config = this.configService.get("chainWatcher", { infer: true });
    if (!config.enabled) {
      this.logger.log("Chain deposit watcher disabled (set CHAIN_WATCHER_ENABLED=true to start it)");
      return;
    }
    this.logger.log(`Chain deposit watcher starting — polling every ${config.pollIntervalMs}ms`);
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => this.logger.error("Unhandled error in deposit watcher poll", error as Error));
    }, config.pollIntervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * One full pass over every active asset/network. A skipped/overlapping
   * tick (still running from last time — a slow provider, a large
   * backlog) is a no-op rather than a pile-up of concurrent scans against
   * the same cursor. Each asset/network's failure is caught and logged
   * independently (requirement #20: observability) so one broken chain
   * integration never stalls every other one.
   */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const assetNetworks = await this.prisma.assetNetwork.findMany({
        where: { isActive: true, asset: { isActive: true }, network: { isActive: true } },
      });
      for (const assetNetwork of assetNetworks) {
        try {
          await this.scanOne(assetNetwork.id);
        } catch (error) {
          this.logger.error(`Deposit scan failed for assetNetwork ${assetNetwork.id}`, error as Error);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  async scanOne(assetNetworkId: string): Promise<void> {
    const addresses = await this.loadWatchedAddresses(assetNetworkId);
    if (addresses.length === 0) return;

    const { adapter, network } = await this.adapterFactory.resolve(assetNetworkId);
    const cursorRow = await this.prisma.blockchainWatchCursor.findUnique({ where: { assetNetworkId } });
    const { deposits, nextCursor } = await adapter.scanForDeposits({
      network,
      addresses,
      cursor: cursorRow?.lastScannedPointer ?? null,
    });

    const requiredConfirmations = await this.confirmationPolicy.getRequiredConfirmations(assetNetworkId);
    const byWalletAddressId = new Map(addresses.map((a) => [a.walletAddressId, a]));

    for (const raw of deposits) {
      const owner = byWalletAddressId.get(raw.walletAddressId);
      if (!owner) continue; // defensive — an adapter must only ever report addresses it was asked to scan

      await this.depositsService.recordObservedTransaction({
        userId: owner.userId,
        assetSymbol: network.assetSymbol,
        assetNetworkId,
        walletAddressId: raw.walletAddressId,
        txHash: raw.txHash,
        eventIndex: raw.eventIndex,
        amount: raw.amount,
        confirmations: raw.confirmations,
        requiredConfirmations,
        destinationTag: raw.destinationTag,
        rawProviderPayload: raw.rawProviderPayload,
      });
    }

    await this.prisma.blockchainWatchCursor.upsert({
      where: { assetNetworkId },
      create: { assetNetworkId, lastScannedPointer: nextCursor },
      update: { lastScannedPointer: nextCursor },
    });
  }

  private async loadWatchedAddresses(assetNetworkId: string): Promise<WatchedAddressWithOwner[]> {
    const rows = await this.prisma.walletAddress.findMany({
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
}
