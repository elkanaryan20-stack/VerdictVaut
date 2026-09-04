/**
 * Read-only chain/provider data access. Implementations call real RPC or
 * custody-provider APIs — they must never synthesize a balance, address,
 * or transaction. No implementation is wired in yet (that's the next
 * piece of work, per asset/network); this interface exists so the rest
 * of the wallet domain can be built against a stable contract now.
 */
export interface ChainBalance {
  address: string;
  assetNetworkId: string;
  balance: string;
  asOf: Date;
}

export interface ChainTransactionStatus {
  txHash: string;
  assetNetworkId: string;
  confirmations: number;
  amount: string;
  status: "not_found" | "pending" | "confirmed";
}

export interface CustodyProvider {
  /** Live balance for an address, straight from the chain/provider — never cached fabrication. */
  getAddressBalance(address: string, assetNetworkId: string): Promise<ChainBalance>;

  /** Live lookup of a transaction's confirmation state. */
  getTransactionStatus(txHash: string, assetNetworkId: string): Promise<ChainTransactionStatus>;
}
