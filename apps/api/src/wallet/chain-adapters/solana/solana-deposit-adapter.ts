import { BadRequestException, Injectable } from "@nestjs/common";
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
import { ChainRpcConfigService } from "../rpc-config.service";
import { SolanaSignatureInfo, SolanaTransaction } from "./solana-rpc.types";
import { mapNativeSolTransactionToDeposits, mapSplTokenTransactionToDeposits } from "./solana-tx.mapper";

// Same rationale as the Bitcoin adapter: re-scanning the most recent
// signature page on every poll is idempotent-safe (recordObservedTransaction
// dedupes by txHash+eventIndex), while a hand-rolled "since this signature"
// pagination bug risks silently skipping a real deposit — strictly worse.
const RECENT_SIGNATURES_LIMIT = 25;
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

    const deposits: RawChainDeposit[] = [];
    for (const watched of params.addresses) {
      const signatures = await fetchJsonRpc<SolanaSignatureInfo[]>(url, "getSignaturesForAddress", [
        watched.address,
        { limit: RECENT_SIGNATURES_LIMIT },
      ]);

      for (const { signature } of signatures) {
        const tx = await fetchJsonRpc<SolanaTransaction | null>(url, "getTransaction", [signature, TX_ENCODING_PARAMS]);
        if (!tx) continue;
        deposits.push(...this.mapTransaction(signature, tx, [watched], currentSlot, params.network));
      }
    }

    return { deposits, nextCursor: new Date().toISOString() };
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
