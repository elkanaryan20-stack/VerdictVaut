import { NetworkFamily } from "@prisma/client";

/**
 * A pool address this adapter should scan, plus the identity it needs to
 * attribute a matched transfer back to a user without querying the DB
 * mid-scan (the watcher already resolved this once).
 */
export interface WatchedAddress {
  walletAddressId: string;
  address: string;
  /** Configured destination tag/memo for this address, if any (e.g. XRP). */
  destinationTag: string | null;
}

export interface AssetNetworkContext {
  assetNetworkId: string;
  assetSymbol: string;
  assetDecimals: number;
  networkFamily: NetworkFamily;
  networkCode: string;
  /** ERC-20-style contract address for a token; null/undefined for a native asset. */
  contractAddress: string | null;
  isNative: boolean;
  /** Whether a destination tag/memo is required to safely attribute a deposit. */
  memoRequired: boolean;
}

/**
 * One raw, unverified observation of value arriving at a watched address.
 * "Raw" and "unverified" because nothing here has been checked against
 * the ConfirmationPolicy or credited yet — this is exactly the shape
 * DepositsService.recordObservedTransaction consumes (see
 * ObservedTransactionInput), translated 1:1 from a specific chain's
 * transaction model by the adapter that understands it.
 */
export interface RawChainDeposit {
  walletAddressId: string;
  txHash: string;
  /** See Deposit.eventIndex — log index / instruction index / output index; 0 when a tx maps to exactly one transfer. */
  eventIndex: number;
  /** Decimal string, already adjusted for the asset's decimals. */
  amount: string;
  confirmations: number;
  /** Present only when the chain transaction carried one (XRP, and similar tag/memo-addressed chains). Never fabricated. */
  destinationTag?: string;
  rawProviderPayload: Record<string, unknown>;
}

export interface ScanForDepositsParams {
  network: AssetNetworkContext;
  addresses: WatchedAddress[];
  /** Opaque cursor from BlockchainWatchCursor.lastScannedPointer, or null on first scan. Adapter-defined format. */
  cursor: string | null;
}

export interface ScanForDepositsResult {
  deposits: RawChainDeposit[];
  /** New cursor to persist — always advanced (or unchanged), never non-deterministic, so re-running a scan with the same cursor is safe. */
  nextCursor: string;
}

export interface InspectTransactionParams {
  network: AssetNetworkContext;
  address: WatchedAddress;
  txHash: string;
  eventIndex: number;
}

/**
 * The one seam between "raw chain data" and the rest of the deposit
 * domain. Implementations call real RPC/provider endpoints and must
 * never synthesize a transaction, address, or confirmation count.
 *
 * Deliberately narrow and chain-specific in spirit even though the
 * signature is shared: BTC, EVM, Solana, and XRP have materially
 * different transaction models (UTXO vs. account vs. instruction-based,
 * with/without tags), and each adapter is expected to encode its own
 * chain's rules internally rather than forcing a lowest-common-denominator
 * abstraction on the caller.
 */
export interface BlockchainDepositAdapter {
  readonly family: NetworkFamily;

  /** Confirms the configured network is reachable and looks like the expected chain (e.g. right chain id / genesis) before any scan runs. */
  validateNetwork(network: AssetNetworkContext): Promise<void>;

  /** Scans watched addresses for deposit activity since `cursor`. Must be safe to call repeatedly with the same cursor (idempotent re-scan). */
  scanForDeposits(params: ScanForDepositsParams): Promise<ScanForDepositsResult>;

  /**
   * Re-checks one specific, already-known transaction's current on-chain
   * state — used by admin reprocessing and reorg-safety re-verification.
   * Returns null if the transaction is no longer found (e.g. dropped
   * from the mempool, or reorged out) — the caller decides what that
   * means for an already-recorded Deposit row.
   */
  inspectTransaction(params: InspectTransactionParams): Promise<RawChainDeposit | null>;
}
