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
  /**
   * "failed" is distinct from "not_found": the chain has a final,
   * immutable record of this transaction (it was mined/validated), but
   * it did NOT successfully deliver value — an EVM revert, an XRPL
   * `tec*`-class result, a Solana `err`-carrying signature status. This
   * is never folded into "not_found" (a chain having no record at all)
   * or "confirmed" (economically successful and final) — see requirement
   * #12 ("verify transaction success") and the explicit "EVM transaction
   * reverted" adversarial test case. A caller must never advance a
   * withdrawal toward CREDITED on a "failed" status.
   */
  status: "not_found" | "pending" | "confirmed" | "failed";
  /**
   * The single unambiguous on-chain recipient, when this chain's
   * transaction model has one (EVM: `to`; XRP: `Destination`). Left
   * undefined for Bitcoin (a transaction can pay multiple outputs, with
   * no single "the" destination without external context) and Solana (no
   * single-recipient concept either) — destination verification for
   * those two is not attempted (requirement #12: "verify destination
   * WHERE PRACTICAL"), a deliberate, documented limitation, not an
   * oversight.
   */
  destinationAddress?: string;
}

export interface CustodyProvider {
  /** Live balance for an address, straight from the chain/provider — never cached fabrication. */
  getAddressBalance(address: string, assetNetworkId: string): Promise<ChainBalance>;

  /** Live lookup of a transaction's confirmation state. */
  getTransactionStatus(txHash: string, assetNetworkId: string): Promise<ChainTransactionStatus>;
}
