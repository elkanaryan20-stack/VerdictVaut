import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
import { AppConfig } from "../../config/configuration";
import { isUniqueConstraintViolation } from "../../prisma/idempotent-create.util";
import { PrismaService } from "../../prisma/prisma.service";
import { DepositChainAdapterFactory } from "../chain-adapters/deposit-chain-adapter.factory";
import { loadWatchedAddresses, WatchedAddressWithOwner } from "../chain-adapters/watched-addresses.util";
import { ConfirmationPolicyService } from "../confirmation/confirmation-policy.service";
import { DepositsService } from "../deposits/deposits.service";
import { LoggingMetricsService, MetricsService } from "../../observability/metrics.service";
import { STALE_CURSOR_THRESHOLD_MS } from "../reconciliation/reconciliation.service";

// A lease older than this is treated as an abandoned/crashed worker's and
// may be reclaimed by another instance (requirement #7: prevent
// duplicate scanning across multiple concurrently-running workers).
// Generous relative to a single scan's real cost (bounded RPC ranges,
// bounded retry/backoff — see retry.util.ts) specifically so a slow but
// still-healthy scan is never mistaken for a dead one.
const LEASE_STALE_AFTER_MS = 5 * 60_000;

// Bounds how long graceful shutdown (onModuleDestroy) waits for an
// in-flight poll to finish before giving up and returning anyway — see
// onModuleDestroy's own docblock.
const GRACEFUL_SHUTDOWN_MAX_WAIT_MS = 30_000;

/**
 * Guards against a cursor ever moving backward (requirement #3: "a
 * cursor must contain enough information to safely resume" — resuming
 * from a REGRESSED cursor means redundant, wasted re-scanning, not a
 * correctness bug per se, since recordObservedTransaction is idempotent,
 * but it's still worth preventing). Only meaningful for the EVM adapter,
 * whose cursor is a single numeric block number. The Bitcoin/Solana/XRP
 * adapters' cursor is a JSON map of one real per-address resume point
 * each (Phase 11 — see per-address-cursor.util.ts) rather than a single
 * number, so it always falls through to `return true` here; those
 * adapters enforce their own never-lose-history invariant internally
 * (an address whose walk-back can't fully catch up keeps its OLD
 * per-address entry rather than advancing past unscanned history).
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
    // Optional with a real default (not a no-op) — Nest's DI always
    // supplies the properly-bound MetricsService; the default only ever
    // applies to the many existing tests that construct this class
    // directly outside Nest's container, none of which need to change.
    private readonly metrics: MetricsService = new LoggingMetricsService(),
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

  /**
   * Graceful shutdown (Phase 16): stop scheduling new poll ticks
   * immediately, then wait for any poll already in flight to finish
   * before returning, so app.close() (SIGTERM in worker.main.ts) never
   * kills the process mid-scan — which would otherwise leave a scan
   * lease held (see acquireLease/LEASE_STALE_AFTER_MS) for up to 5
   * minutes with no work actually happening, and could interrupt a
   * chain adapter mid-request. Bounded (not an unbounded await) so a
   * genuinely stuck poll can't block shutdown forever; the lease's own
   * staleness timeout is the backstop if this bound is ever hit.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + GRACEFUL_SHUTDOWN_MAX_WAIT_MS;
    while (this.polling && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.polling) {
      this.logger.warn(`Shutting down with a deposit scan still in flight after waiting ${GRACEFUL_SHUTDOWN_MAX_WAIT_MS}ms — its lease will expire naturally via LEASE_STALE_AFTER_MS.`);
    }
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
    try {
      await this.prisma.blockchainWatchCursor.upsert({
        where: { assetNetworkId },
        create: { assetNetworkId, lastScannedPointer: "" },
        update: {},
      });
    } catch (error) {
      // A genuine race on the very first-ever scan of a brand-new
      // asset/network: two workers' upserts can both attempt the INSERT
      // branch concurrently, and the loser sees a real unique-constraint
      // violation here rather than a clean "row already exists" outcome.
      // The row now definitely exists either way, so it's safe to fall
      // through to the CAS below rather than treat this as a scan failure.
      if (!isUniqueConstraintViolation(error, "assetNetworkId")) throw error;
    }

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
    this.metrics.increment("wallet.deposit_watcher.scan_failed", { assetNetworkId });
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
    return loadWatchedAddresses(this.prisma, assetNetworkId);
  }
}
