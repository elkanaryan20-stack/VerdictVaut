import { rawUnitsToDecimalString } from "../decimal-units.util";
import { RawChainDeposit, WatchedAddress } from "../deposit-chain-adapter.interface";
import { EvmBlock, EvmLog, EvmTransaction, hexToBlockNumber, topicToAddress } from "./evm-json-rpc.types";

function byLowercaseAddress(addresses: WatchedAddress[]): Map<string, WatchedAddress> {
  return new Map(addresses.map((a) => [a.address.toLowerCase(), a]));
}

/**
 * Pure mapping from one fetched block's transactions to native-ETH
 * deposit observations landing on any watched address in this scan.
 * Native transfers and ERC-20 transfers are deliberately never handled
 * by the same code path — a native value-transfer transaction carries no
 * Transfer log, and a token transfer's `tx.value` is always zero, so
 * conflating them would either miss deposits or double-count them.
 */
export function mapNativeBlockToDeposits(block: EvmBlock, watched: WatchedAddress[], currentBlock: number, decimals: number): RawChainDeposit[] {
  const byAddress = byLowercaseAddress(watched);
  const blockNumber = hexToBlockNumber(block.number);
  const confirmations = Math.max(currentBlock - blockNumber + 1, 0);

  const deposits: RawChainDeposit[] = [];
  for (const tx of block.transactions) {
    const match = tx.to ? byAddress.get(tx.to.toLowerCase()) : undefined;
    if (!match) continue;
    const value = BigInt(tx.value);
    if (value === 0n) continue;

    deposits.push({
      walletAddressId: match.walletAddressId,
      txHash: tx.hash,
      eventIndex: 0,
      amount: rawUnitsToDecimalString(value, decimals),
      confirmations,
      rawProviderPayload: tx as unknown as Record<string, unknown>,
    });
  }
  return deposits;
}

/**
 * Pure mapping from one ERC-20 Transfer log to a deposit observation, or
 * null if it doesn't land on a watched address. `eventIndex` is the
 * log's index within its transaction (log.logIndex) — the identity that
 * distinguishes multiple transfers to different users inside one batched
 * transaction, per the Deposit model's documented event-index contract.
 *
 * `expectedContractAddress` is checked explicitly here rather than
 * trusted from the caller: the scanning path already asks eth_getLogs to
 * filter by `address` server-side, but ANY contract can emit a
 * log shaped exactly like an ERC-20 Transfer (same topic0 signature) —
 * that filter is the only thing standing between "real USDC transfer"
 * and "a worthless token pretending to be one" for a caller that reads
 * an unfiltered log list (as inspectTransaction's receipt.logs does).
 * Verifying it again here means this function is correct on its own
 * terms, not just correct because of how it happens to be called today.
 */
export function mapTransferLogToDeposit(
  log: EvmLog,
  watched: WatchedAddress[],
  currentBlock: number,
  decimals: number,
  expectedContractAddress: string,
): RawChainDeposit | null {
  // A log flagged `removed` was reorged out of the canonical chain —
  // never treat it as a real observation (reorg/reversal safety).
  if (log.removed) return null;
  if (log.address.toLowerCase() !== expectedContractAddress.toLowerCase()) return null;
  if (log.topics.length < 3) return null;

  const byAddress = byLowercaseAddress(watched);
  const recipient = topicToAddress(log.topics[2]);
  const match = byAddress.get(recipient);
  if (!match) return null;

  const blockNumber = hexToBlockNumber(log.blockNumber);
  const confirmations = Math.max(currentBlock - blockNumber + 1, 0);

  return {
    walletAddressId: match.walletAddressId,
    txHash: log.transactionHash,
    eventIndex: hexToBlockNumber(log.logIndex),
    amount: rawUnitsToDecimalString(BigInt(log.data), decimals),
    confirmations,
    rawProviderPayload: log as unknown as Record<string, unknown>,
  };
}

export type { EvmTransaction };
