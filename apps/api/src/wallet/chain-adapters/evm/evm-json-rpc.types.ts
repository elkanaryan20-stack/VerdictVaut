/** Minimal Ethereum JSON-RPC shapes — only the fields these adapters actually read. All numeric fields are 0x-prefixed hex strings, per the JSON-RPC spec. */
export interface EvmTransaction {
  hash: string;
  to: string | null;
  from: string;
  value: string;
  blockNumber: string | null;
}

export interface EvmBlock {
  number: string;
  transactions: EvmTransaction[];
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

export interface EvmTransactionReceipt {
  status: string;
  blockNumber: string;
  logs: EvmLog[];
}

/** keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer event signature topic. */
export const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export function hexToBlockNumber(hex: string): number {
  return Number(BigInt(hex));
}

export function blockNumberToHex(n: number): string {
  return `0x${n.toString(16)}`;
}

/** Left-pads a 20-byte EVM address into a 32-byte indexed-topic value, as `eth_getLogs` expects for topic filters. */
export function addressToTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

/** Recovers a 20-byte address from a 32-byte indexed topic value (the inverse of addressToTopic). */
export function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}
