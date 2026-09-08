import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { WalletAddressStatus } from "@prisma/client";
import * as crypto from "crypto";
import { AppConfig } from "../../config/configuration";
import { PrismaService } from "../../prisma/prisma.service";
import { DepositChainAdapterFactory } from "../chain-adapters/deposit-chain-adapter.factory";
import { WatchedAddress } from "../chain-adapters/deposit-chain-adapter.interface";
import { ConfirmationPolicyService } from "../confirmation/confirmation-policy.service";
import { DepositsService } from "../deposits/deposits.service";
import { STALE_CURSOR_THRESHOLD_MS } from "../reconciliation/reconciliation.service";

interface WatchedAddressWithOwner extends WatchedAddress {
  userId: string;
}

// A lease older than this is treated as an abandoned/crashed worker's and
// may be reclaimed by another instance (requirement #7: prevent
// duplicate scanning across multiple concurrently-running workers).
// Generous relative to a single scan's real cost (bounded RPC ranges,
// bounded retry/backoff — see retry.util.ts) specifically so a slow but
// still-healthy scan is never mistaken for a dead one.
const LEASE_STALE_AFTER_MS = 5 * 60_000;

/**
 * Guards against a cursor ever moving backward (requirement #3: "a
 * cursor must contain enough information to safely resume" — resuming
 * from a REGRESSED cursor means redundant, wasted re-scanning, not a
 * correctness bug per se, since recordObservedTransaction is idempotent,
 * but it's still worth preventing). Only meaningful for a chain whose
 * cursor is an actual resume point (EVM's is a block number) — the
 * Bitcoin/Solana/XRP adapters' cursors are purely informational
 * timestamps that are never read back as scan input (each poll always
 * re-derives its own recent window fresh from live chain state), so a
 * non-numeric cursor always advances.
 */
function shouldAdvanceCursor(current: string | null, next: string): boolean {
  if (current == null || current === "") return true;
  const currentNum = Number(current);
  const nextNum = Number(next);
  if (Number.isFinite(currentNum) && Number.isFinite(nextNum)) {
    return nextNum >= currentNum;
  }
  return true;
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
  // One id per process, stable for its lifetime — identifies which
  // instance currently holds a given asset/network's scan lease (see
  // BlockchainWatchCursor.lockedBy). Never a secret; safe to expose in
  // admin operational visibility.
  private readonly workerId = crypto.randomUUID();

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

    const leaseAcquired = await this.acquireLease(assetNetworkId);
    if (!leaseAcquired) {
      this.logger.debug(`Skipping assetNetwork ${assetNetworkId} — its scan lease is held by another worker.`);
      return;
    }

    let currentCursor: string | null = null;
    try {
      const { adapter, network } = await this.adapterFactory.resolve(assetNetworkId);
      const cursorRow = await this.prisma.blockchainWatchCursor.findUnique({ where: { assetNetworkId } });
      currentCursor = cursorRow?.lastScannedPointer || null;
      const { deposits, nextCursor } = await adapter.scanForDeposits({
        network,
        addresses,
        cursor: currentCursor,
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

      await this.releaseLeaseAfterSuccess(assetNetworkId, currentCursor, nextCursor);
    } catch (error) {
      // The cursor is deliberately NOT touched here — a scan that didn't
      // complete must never be recorded as having advanced (requirement
      // #8: "do not advance a cursor when the relevant scan was not
      // successfully completed"). Only the lease is released (so another
      // worker, or this one on the next poll, can retry) and the failure
      // is recorded for operational visibility.
      await this.releaseLeaseAfterError(assetNetworkId, error as Error);
      throw error;
    }
  }

  /**
   * CAS-acquires this asset/network's scan lease: succeeds if no one
   * currently holds it, or if the holder's lease has gone stale (a
   * crashed worker never released it). The upsert first guarantees a
   * cursor row exists to lock at all — safe/idempotent to run on every
   * call (a no-op `update: {}` against an existing row never touches its
   * lock or cursor state).
   */
  private async acquireLease(assetNetworkId: string): Promise<boolean> {
    await this.prisma.blockchainWatchCursor.upsert({
      where: { assetNetworkId },
      create: { assetNetworkId, lastScannedPointer: "" },
      update: {},
    });

    const staleThreshold = new Date(Date.now() - LEASE_STALE_AFTER_MS);
    const result = await this.prisma.blockchainWatchCursor.updateMany({
      where: { assetNetworkId, OR: [{ lockedAt: null }, { lockedAt: { lt: staleThreshold } }] },
      data: { lockedAt: new Date(), lockedBy: this.workerId },
    });
    return result.count > 0;
  }

  /**
   * Releases the lease only if THIS worker still holds it (`lockedBy`
   * guard) — if a scan ran long enough for the lease to be reclaimed by
   * another worker mid-scan, this call becomes a safe no-op rather than
   * clobbering the new holder's lock or cursor.
   */
  private async releaseLeaseAfterSuccess(assetNetworkId: string, currentCursor: string | null, nextCursor: string): Promise<void> {
    const advancedCursor = shouldAdvanceCursor(currentCursor, nextCursor) ? nextCursor : (currentCursor ?? nextCursor);
    await this.prisma.blockchainWatchCursor.updateMany({
      where: { assetNetworkId, lockedBy: this.workerId },
      data: {
        lastScannedPointer: advancedCursor,
        lockedAt: null,
        lockedBy: null,
        lastSuccessAt: new Date(),
        lastError: null,
        lastErrorAt: null,
      },
    });
  }

  private async releaseLeaseAfterError(assetNetworkId: string, error: Error): Promise<void> {
    await this.prisma.blockchainWatchCursor.updateMany({
      where: { assetNetworkId, lockedBy: this.workerId },
      data: { lockedAt: null, lockedBy: null, lastError: error.message.slice(0, 2000), lastErrorAt: new Date() },
    });
  }

  /**
   * Operational visibility (requirement #15): every asset/network's
   * current cursor/lease/error state, for a SUPER_ADMIN (or read-only
   * ADMIN, per the existing admin-controller authorization pattern) to
   * see watcher health without reading server logs. `isStale` mirrors
   * ReconciliationService's own stale-cursor check so the same asset/
   * network is never classified two different ways in two different
   * places.
   */
  async listCursorStatus() {
    const cursors = await this.prisma.blockchainWatchCursor.findMany({
      include: { assetNetwork: { include: { asset: true, network: true } } },
      orderBy: { updatedAt: "desc" },
    });

    const now = Date.now();
    return cursors.map((cursor) => {
      const referenceTime = (cursor.lastSuccessAt ?? cursor.updatedAt).getTime();
      return {
        assetNetworkId: cursor.assetNetworkId,
        assetSymbol: cursor.assetNetwork.asset.symbol,
        networkCode: cursor.assetNetwork.network.code,
        lastScannedPointer: cursor.lastScannedPointer,
        lockedAt: cursor.lockedAt,
        lockedBy: cursor.lockedBy,
        lastSuccessAt: cursor.lastSuccessAt,
        lastError: cursor.lastError,
        lastErrorAt: cursor.lastErrorAt,
        isLeaseStale: cursor.lockedAt != null && now - cursor.lockedAt.getTime() > LEASE_STALE_AFTER_MS,
        isScanStale: now - referenceTime > STALE_CURSOR_THRESHOLD_MS,
      };
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
