import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { NetworkFamily } from "@prisma/client";
import { fetchJson } from "../chain-http.util";
import {
  AssetNetworkContext,
  BlockchainDepositAdapter,
  InspectTransactionParams,
  RawChainDeposit,
  ScanForDepositsParams,
  ScanForDepositsResult,
} from "../deposit-chain-adapter.interface";
import { PerAddressCursor, parsePerAddressCursor, serializePerAddressCursor } from "../per-address-cursor.util";
import { ChainRpcConfigService } from "../rpc-config.service";
import { EsploraTx } from "./bitcoin-esplora.types";
import { mapEsploraTxToDeposits } from "./bitcoin-tx.mapper";

// Esplora's fixed page size (not configurable by the caller).
const PAGE_SIZE = 25;
// Bounds worst-case RPC calls per watched address per poll to this many
// pages (Phase 11 fix — see per-address-cursor.util.ts doc). If more than
// PAGE_SIZE * MAX_PAGES_PER_ADDRESS transactions land on one address
// between two polls, the walk-back below won't fully catch up in a single
// pass — but critically the cursor for that address is NOT advanced past
// what was actually reached (see caughtUp below), so the next poll simply
// resumes the walk-back from the exact same known-safe point. Nothing is
// ever silently, permanently skipped; a sustained flood only delays
// detection, it never loses it.
const MAX_PAGES_PER_ADDRESS = 20;

/**
 * Bitcoin deposit adapter, backed by an Esplora-compatible REST API
 * (Blockstream's public instance by default — see rpc-config.service.ts).
 * Walks each watched address's transaction history backward from the
 * newest page (via Esplora's `/txs/chain/:last_seen_txid` continuation)
 * until it reaches the last-seen txid recorded on the previous
 * successful scan, bounded by MAX_PAGES_PER_ADDRESS. recordObservedTransaction
 * is idempotent per (assetNetworkId, txHash, eventIndex), so re-observing
 * already-known transactions while walking back is always safe.
 */
@Injectable()
export class BitcoinDepositAdapter implements BlockchainDepositAdapter {
  readonly family = NetworkFamily.BITCOIN;
  private readonly logger = new Logger(BitcoinDepositAdapter.name);

  constructor(private readonly rpcConfig: ChainRpcConfigService) {}

  async validateNetwork(network: AssetNetworkContext): Promise<void> {
    const baseUrl = this.rpcConfig.getRpcUrl(network.networkCode);
    const height = await fetchJson<number>(`${baseUrl}/blocks/tip/height`);
    if (typeof height !== "number" || height <= 0) {
      throw new ServiceUnavailableException(`Bitcoin provider for ${network.networkCode} returned an implausible tip height`);
    }
  }

  async scanForDeposits(params: ScanForDepositsParams): Promise<ScanForDepositsResult> {
    const baseUrl = this.rpcConfig.getRpcUrl(params.network.networkCode);
    const tipHeight = await fetchJson<number>(`${baseUrl}/blocks/tip/height`);
    const previousCursors = parsePerAddressCursor(params.cursor);
    const nextCursors: PerAddressCursor = { ...previousCursors };

    const deposits: RawChainDeposit[] = [];
    for (const watched of params.addresses) {
      const previousLastSeenTxid = previousCursors[watched.address] ?? null;
      const { txs, caughtUp } = await this.fetchAddressHistory(baseUrl, watched.address, previousLastSeenTxid);
      for (const tx of txs) {
        deposits.push(...mapEsploraTxToDeposits(tx, watched, tipHeight));
      }

      if (txs.length === 0) continue;
      if (caughtUp) {
        nextCursors[watched.address] = txs[0].txid;
      } else {
        this.logger.warn(
          `Bitcoin address ${watched.address} has more unscanned history than fits in ${MAX_PAGES_PER_ADDRESS} pages — cursor left unchanged, will resume next poll.`,
        );
      }
    }

    return { deposits, nextCursor: serializePerAddressCursor(nextCursors) };
  }

  /**
   * Fetches newest-first, paginating backward via `/txs/chain/:txid` until
   * either `previousLastSeenTxid` is found among the results (caughtUp:
   * true — every transaction since the last successful scan has been
   * re-observed) or MAX_PAGES_PER_ADDRESS is reached (caughtUp: false —
   * see the cursor-non-advancement note above). A null previousLastSeenTxid
   * (first-ever scan of this address) fetches exactly one page, matching
   * the EVM adapter's bounded-initial-backfill philosophy.
   */
  private async fetchAddressHistory(
    baseUrl: string,
    address: string,
    previousLastSeenTxid: string | null,
  ): Promise<{ txs: EsploraTx[]; caughtUp: boolean }> {
    let page = await fetchJson<EsploraTx[]>(`${baseUrl}/address/${address}/txs`);
    const collected = [...page];
    let caughtUp = previousLastSeenTxid == null || page.some((tx) => tx.txid === previousLastSeenTxid);
    let pagesFetched = 1;

    while (!caughtUp && page.length === PAGE_SIZE && pagesFetched < MAX_PAGES_PER_ADDRESS) {
      const oldestTxidThisPage = page[page.length - 1].txid;
      page = await fetchJson<EsploraTx[]>(`${baseUrl}/address/${address}/txs/chain/${oldestTxidThisPage}`);
      collected.push(...page);
      pagesFetched += 1;
      caughtUp = page.some((tx) => tx.txid === previousLastSeenTxid);
    }

    // A short final page (fewer than PAGE_SIZE) proves there's no more
    // history to walk back through at all — the previous cursor's txid
    // being absent then means it's genuinely gone (e.g. an unconfirmed
    // transaction that was replaced/dropped), not that we stopped early.
    // There's nothing left to be missing, so it's safe to advance.
    const exhaustedAllHistory = page.length < PAGE_SIZE;
    return { txs: collected, caughtUp: caughtUp || exhaustedAllHistory };
  }

  async inspectTransaction(params: InspectTransactionParams): Promise<RawChainDeposit | null> {
    const baseUrl = this.rpcConfig.getRpcUrl(params.network.networkCode);
    const [tx, tipHeight] = await Promise.all([
      this.fetchTxOrNull(baseUrl, params.txHash),
      fetchJson<number>(`${baseUrl}/blocks/tip/height`),
    ]);
    if (!tx) return null;

    const mapped = mapEsploraTxToDeposits(tx, params.address, tipHeight);
    return mapped.find((d) => d.eventIndex === params.eventIndex) ?? null;
  }

  /**
   * A 404 genuinely means "no such transaction" and is the only case
   * mapped to null — any other failure (timeout, 5xx, network error)
   * propagates as a real error instead of being silently mistaken for
   * "not found", which would otherwise risk wrongly rejecting a deposit
   * that is actually still perfectly valid on chain.
   */
  private async fetchTxOrNull(baseUrl: string, txHash: string): Promise<EsploraTx | null> {
    const response = await fetch(`${baseUrl}/tx/${txHash}`);
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ServiceUnavailableException(`Bitcoin provider request failed: GET /tx/${txHash} -> ${response.status}`);
    }
    return (await response.json()) as EsploraTx;
  }
}
