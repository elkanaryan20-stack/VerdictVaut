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
import {
  ERC20_TRANSFER_TOPIC,
  EvmBlock,
  EvmLog,
  EvmTransaction,
  EvmTransactionReceipt,
  addressToTopic,
  blockNumberToHex,
  hexToBlockNumber,
} from "./evm-json-rpc.types";
import { mapNativeBlockToDeposits, mapTransferLogToDeposit } from "./evm-tx.mapper";

// How far back to look on the very first scan (no cursor yet) — bounded
// so a newly-activated asset/network never triggers an unbounded
// from-genesis backfill. A real backfill of older deposits, if ever
// needed, is an explicit admin/reconciliation operation, not something
// the live watcher does implicitly.
const INITIAL_BACKFILL_BLOCKS = 2000;
// eth_getLogs is one call regardless of range width, but public RPC
// providers cap how wide a range they'll accept — stay comfortably
// under that.
const LOG_SCAN_MAX_BLOCK_RANGE = 500;
// Native-transfer scanning fetches one full block per block number in
// range, so the per-poll cap is much smaller than the log-scan one to
// bound how many requests a single poll makes against a public RPC.
const NATIVE_SCAN_MAX_BLOCK_RANGE = 50;
// The cursor must NEVER advance past a block that could still be
// reorged out — unlike the Bitcoin/Solana/XRP adapters (which always
// re-derive their "recent window" fresh from live chain state on every
// poll, so a reorg is simply reflected on the next call), this adapter's
// cursor permanently excludes everything at or below it from ever being
// scanned again. If the cursor advanced all the way to the chain tip and
// a shallow reorg later replaced that block with a DIFFERENT transaction
// (one that happens to be a real deposit), that deposit would never be
// observed — silently and permanently. Leaving the most recent
// REORG_SAFETY_MARGIN_BLOCKS blocks perpetually unadvanced means they
// get re-scanned on every poll until they age past this margin; re-scans
// are idempotent (recordObservedTransaction dedupes), so the only cost
// is a bit of redundant work near the tip, not a correctness risk.
const REORG_SAFETY_MARGIN_BLOCKS = 12;

/**
 * EVM deposit adapter (ETH native transfers and ERC-20 token transfers),
 * backed by plain JSON-RPC — no indexer/API-key dependency, so it works
 * against any standard node or public RPC endpoint (see
 * rpc-config.service.ts for the default Sepolia/Base Sepolia endpoints).
 *
 * One AssetNetwork row is always either native or a specific token
 * contract (see AssetNetwork.isNative/contractAddress) — never both — so
 * a single scan call only ever exercises one of the two code paths
 * below, and native ETH and an ERC-20 on the same chain never get
 * conflated into one transfer identity.
 */
@Injectable()
export class EvmDepositAdapter implements BlockchainDepositAdapter {
  readonly family = NetworkFamily.EVM;

  constructor(private readonly rpcConfig: ChainRpcConfigService) {}

  async validateNetwork(network: AssetNetworkContext): Promise<void> {
    const url = this.rpcConfig.getRpcUrl(network.networkCode);
    const blockHex = await fetchJsonRpc<string>(url, "eth_blockNumber", []);
    if (!blockHex || hexToBlockNumber(blockHex) <= 0) {
      throw new BadRequestException(`EVM provider for ${network.networkCode} returned an implausible block number`);
    }
    if (!network.isNative && !network.contractAddress) {
      throw new BadRequestException(`AssetNetwork ${network.assetNetworkId} is a token but has no contractAddress configured`);
    }
  }

  async scanForDeposits(params: ScanForDepositsParams): Promise<ScanForDepositsResult> {
    const url = this.rpcConfig.getRpcUrl(params.network.networkCode);
    const currentBlock = hexToBlockNumber(await fetchJsonRpc<string>(url, "eth_blockNumber", []));

    const maxRange = params.network.isNative ? NATIVE_SCAN_MAX_BLOCK_RANGE : LOG_SCAN_MAX_BLOCK_RANGE;
    const cursorBlock = params.cursor ? parseInt(params.cursor, 10) : currentBlock - INITIAL_BACKFILL_BLOCKS;
    const fromBlock = Math.max(cursorBlock + 1, 0);
    // Never scan (and therefore never advance the cursor) past this —
    // see REORG_SAFETY_MARGIN_BLOCKS.
    const scanCeiling = currentBlock - REORG_SAFETY_MARGIN_BLOCKS;
    const toBlock = Math.min(scanCeiling, fromBlock + maxRange - 1);

    if (fromBlock > toBlock) {
      // Nothing is safely scannable yet (either fully caught up, or the
      // chain simply hasn't produced REORG_SAFETY_MARGIN_BLOCKS worth of
      // new blocks since the last poll) — the cursor must NOT move.
      return { deposits: [], nextCursor: params.cursor ?? String(fromBlock - 1) };
    }

    const deposits = params.network.isNative
      ? await this.scanNative(url, fromBlock, toBlock, currentBlock, params)
      : await this.scanToken(url, fromBlock, toBlock, currentBlock, params);

    return { deposits, nextCursor: String(toBlock) };
  }

  async inspectTransaction(params: InspectTransactionParams): Promise<RawChainDeposit | null> {
    const url = this.rpcConfig.getRpcUrl(params.network.networkCode);
    const currentBlock = hexToBlockNumber(await fetchJsonRpc<string>(url, "eth_blockNumber", []));

    if (params.network.isNative) {
      const tx = await fetchJsonRpc<EvmTransaction | null>(url, "eth_getTransactionByHash", [params.txHash]);
      if (!tx || !tx.blockNumber) return null;
      const receipt = await fetchJsonRpc<EvmTransactionReceipt | null>(url, "eth_getTransactionReceipt", [params.txHash]);
      if (!receipt || receipt.status !== "0x1") return null;

      const mapped = mapNativeBlockToDeposits(
        { number: tx.blockNumber, transactions: [tx] },
        [params.address],
        currentBlock,
        params.network.assetDecimals,
      );
      return mapped[0] ?? null;
    }

    const receipt = await fetchJsonRpc<EvmTransactionReceipt | null>(url, "eth_getTransactionReceipt", [params.txHash]);
    if (!receipt || receipt.status !== "0x1") return null;

    for (const log of receipt.logs) {
      if (hexToBlockNumber(log.logIndex) !== params.eventIndex) continue;
      const mapped = mapTransferLogToDeposit(log, [params.address], currentBlock, params.network.assetDecimals, params.network.contractAddress!);
      if (mapped) return mapped;
    }
    return null;
  }

  private async scanNative(
    url: string,
    fromBlock: number,
    toBlock: number,
    currentBlock: number,
    params: ScanForDepositsParams,
  ): Promise<RawChainDeposit[]> {
    const candidates: RawChainDeposit[] = [];
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      const block = await fetchJsonRpc<EvmBlock | null>(url, "eth_getBlockByNumber", [blockNumberToHex(blockNumber), true]);
      if (!block) continue;
      candidates.push(...mapNativeBlockToDeposits(block, params.addresses, currentBlock, params.network.assetDecimals));
    }

    // A block listing does not say whether a transaction actually
    // succeeded — a transaction that reverted still appears in the
    // block with its requested `value`, but the EVM rolls back the
    // ENTIRE state transition on revert, including the value transfer,
    // so no balance change actually happened. Confirming each candidate
    // against its own receipt (as inspectTransaction already does) is
    // the only way to be sure a "deposit" here isn't fabricated from a
    // failed transaction. Only candidates that already passed the
    // address/nonzero-value filter incur this extra call, so the cost
    // stays proportional to real deposit activity, not block volume.
    const confirmed: RawChainDeposit[] = [];
    for (const candidate of candidates) {
      const receipt = await fetchJsonRpc<EvmTransactionReceipt | null>(url, "eth_getTransactionReceipt", [candidate.txHash]);
      if (receipt?.status === "0x1") confirmed.push(candidate);
    }
    return confirmed;
  }

  private async scanToken(
    url: string,
    fromBlock: number,
    toBlock: number,
    currentBlock: number,
    params: ScanForDepositsParams,
  ): Promise<RawChainDeposit[]> {
    const logs = await fetchJsonRpc<EvmLog[]>(url, "eth_getLogs", [
      {
        address: params.network.contractAddress,
        fromBlock: blockNumberToHex(fromBlock),
        toBlock: blockNumberToHex(toBlock),
        topics: [ERC20_TRANSFER_TOPIC, null, params.addresses.map((a) => addressToTopic(a.address))],
      },
    ]);

    const deposits: RawChainDeposit[] = [];
    for (const log of logs) {
      const mapped = mapTransferLogToDeposit(log, params.addresses, currentBlock, params.network.assetDecimals, params.network.contractAddress!);
      if (mapped) deposits.push(mapped);
    }
    return deposits;
  }
}
