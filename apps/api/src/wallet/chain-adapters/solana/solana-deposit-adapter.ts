import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { NetworkFamily } from "@prisma/client";
import { fetchJsonRpc } from "../chain-http.util";
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
import { SolanaSignatureInfo, SolanaTransaction } from "./solana-rpc.types";
import { mapNativeSolTransactionToDeposits, mapSplTokenTransactionToDeposits } from "./solana-tx.mapper";

const RECENT_SIGNATURES_LIMIT = 25;
// Bounds worst-case RPC calls per watched address per poll (Phase 11 fix —
// see per-address-cursor.util.ts and the Bitcoin adapter's matching
// comment for the full rationale: a scan that can't fully catch up within
// this cap simply leaves that address's cursor unchanged rather than
// advancing past unscanned history, so nothing is ever silently lost).
const MAX_PAGES_PER_ADDRESS = 20;
const TX_ENCODING_PARAMS = { encoding: "json", maxSupportedTransactionVersion: 0 };

/**
 * Solana deposit adapter (native SOL and SPL token transfers), backed by
 * plain JSON-RPC (getSignaturesForAddress / getTransaction / getSlot) —
 * see rpc-config.service.ts for the default public devnet endpoint.
 *
 * Native and SPL-token transfers have different transaction/account
 * models (lamport balance deltas vs. token-account balance deltas) and
 * are deliberately handled by separate mapper functions — see
 * solana-tx.mapper.ts — never conflated into one code path.
 */
@Injectable()
export class SolanaDepositAdapter implements BlockchainDepositAdapter {
  readonly family = NetworkFamily.SOLANA;
  private readonly logger = new Logger(SolanaDepositAdapter.name);

  constructor(private readonly rpcConfig: ChainRpcConfigService) {}

  async validateNetwork(network: AssetNetworkContext): Promise<void> {
    const url = this.rpcConfig.getRpcUrl(network.networkCode);
    const slot = await fetchJsonRpc<number>(url, "getSlot", []);
    if (typeof slot !== "number" || slot <= 0) {
      throw new BadRequestException(`Solana provider for ${network.networkCode} returned an implausible slot`);
    }
    if (!network.isNative && !network.contractAddress) {
      throw new BadRequestException(`AssetNetwork ${network.assetNetworkId} is an SPL token but has no mint (contractAddress) configured`);
    }
  }

  async scanForDeposits(params: ScanForDepositsParams): Promise<ScanForDepositsResult> {
    const url = this.rpcConfig.getRpcUrl(params.network.networkCode);
    const currentSlot = await fetchJsonRpc<number>(url, "getSlot", []);
    const previousCursors = parsePerAddressCursor(params.cursor);
    const nextCursors: PerAddressCursor = { ...previousCursors };

    const deposits: RawChainDeposit[] = [];
    for (const watched of params.addresses) {
      const previousLastSeenSignature = previousCursors[watched.address] ?? null;
      const { signatures, caughtUp } = await this.fetchSignatureHistory(url, watched.address, previousLastSeenSignature);

      for (const { signature } of signatures) {
        const tx = await fetchJsonRpc<SolanaTransaction | null>(url, "getTransaction", [signature, TX_ENCODING_PARAMS]);
        if (!tx) continue;
        deposits.push(...this.mapTransaction(signature, tx, [watched], currentSlot, params.network));
      }

      if (signatures.length === 0) continue;
      if (caughtUp) {
        nextCursors[watched.address] = signatures[0].signature;
      } else {
        this.logger.warn(
          `Solana address ${watched.address} has more unscanned history than fits in ${MAX_PAGES_PER_ADDRESS} pages — cursor left unchanged, will resume next poll.`,
        );
      }
    }

    return { deposits, nextCursor: serializePerAddressCursor(nextCursors) };
  }

  /**
   * Fetches newest-first, paginating backward via `before` until either
   * `previousLastSeenSignature` is found among the results (caughtUp)
   * or MAX_PAGES_PER_ADDRESS is reached — see the Bitcoin adapter's
   * fetchAddressHistory for the identical, fully-commented rationale.
   */
  private async fetchSignatureHistory(
    url: string,
    address: string,
    previousLastSeenSignature: string | null,
  ): Promise<{ signatures: SolanaSignatureInfo[]; caughtUp: boolean }> {
    let page = await fetchJsonRpc<SolanaSignatureInfo[]>(url, "getSignaturesForAddress", [
      address,
      { limit: RECENT_SIGNATURES_LIMIT },
    ]);
    const collected = [...page];
    let caughtUp = previousLastSeenSignature == null || page.some((s) => s.signature === previousLastSeenSignature);
    let pagesFetched = 1;

    while (!caughtUp && page.length === RECENT_SIGNATURES_LIMIT && pagesFetched < MAX_PAGES_PER_ADDRESS) {
      const before = page[page.length - 1].signature;
      page = await fetchJsonRpc<SolanaSignatureInfo[]>(url, "getSignaturesForAddress", [address, { limit: RECENT_SIGNATURES_LIMIT, before }]);
      collected.push(...page);
      pagesFetched += 1;
      caughtUp = page.some((s) => s.signature === previousLastSeenSignature);
    }

    // A short final page proves there's no more history to walk back
    // through — the previous cursor's signature being absent then means
    // it's genuinely gone, not that the walk-back stopped early.
    const exhaustedAllHistory = page.length < RECENT_SIGNATURES_LIMIT;
    return { signatures: collected, caughtUp: caughtUp || exhaustedAllHistory };
  }

  async inspectTransaction(params: InspectTransactionParams): Promise<RawChainDeposit | null> {
    const url = this.rpcConfig.getRpcUrl(params.network.networkCode);
    const [tx, currentSlot] = await Promise.all([
      fetchJsonRpc<SolanaTransaction | null>(url, "getTransaction", [params.txHash, TX_ENCODING_PARAMS]),
      fetchJsonRpc<number>(url, "getSlot", []),
    ]);
    if (!tx) return null;

    const mapped = this.mapTransaction(params.txHash, tx, [params.address], currentSlot, params.network);
    return mapped.find((d) => d.eventIndex === params.eventIndex) ?? null;
  }

  private mapTransaction(
    signature: string,
    tx: SolanaTransaction,
    watched: Parameters<typeof mapNativeSolTransactionToDeposits>[2],
    currentSlot: number,
    network: AssetNetworkContext,
  ): RawChainDeposit[] {
    if (network.isNative) {
      return mapNativeSolTransactionToDeposits(signature, tx, watched, currentSlot, network.assetDecimals);
    }
    return mapSplTokenTransactionToDeposits(signature, tx, watched, currentSlot, network.contractAddress!, network.assetDecimals);
  }
}
