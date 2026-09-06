import { Injectable, ServiceUnavailableException } from "@nestjs/common";
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
import { ChainRpcConfigService } from "../rpc-config.service";
import { EsploraTx } from "./bitcoin-esplora.types";
import { mapEsploraTxToDeposits } from "./bitcoin-tx.mapper";

/**
 * Bitcoin deposit adapter, backed by an Esplora-compatible REST API
 * (Blockstream's public instance by default — see rpc-config.service.ts).
 * Deliberately scans only each watched address's most recent page of
 * transactions per poll (Esplora returns up to 25, newest first) rather
 * than paginating an unbounded history: recordObservedTransaction is
 * idempotent per (assetNetworkId, txHash, eventIndex), so re-observing
 * the same recent window on every poll is always safe, while a
 * hand-rolled pagination cursor that has an off-by-one bug could silently
 * skip a real deposit — the worse failure mode by far. A watcher polling
 * every `pollIntervalMs` will see a new transaction well within this
 * page regardless.
 */
@Injectable()
export class BitcoinDepositAdapter implements BlockchainDepositAdapter {
  readonly family = NetworkFamily.BITCOIN;

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

    const deposits: RawChainDeposit[] = [];
    for (const watched of params.addresses) {
      const txs = await fetchJson<EsploraTx[]>(`${baseUrl}/address/${watched.address}/txs`);
      for (const tx of txs) {
        deposits.push(...mapEsploraTxToDeposits(tx, watched, tipHeight));
      }
    }

    return { deposits, nextCursor: new Date().toISOString() };
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
