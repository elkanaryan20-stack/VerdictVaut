import { rawUnitsToDecimalString } from "../decimal-units.util";
import { WatchedAddress, RawChainDeposit } from "../deposit-chain-adapter.interface";
import { EsploraTx } from "./bitcoin-esplora.types";

/**
 * Pure mapping from one Esplora transaction to zero or more raw deposit
 * observations for a single watched address — UTXO transactions can pay
 * the same address in more than one output, so eventIndex is the vout
 * index (see Deposit.eventIndex doc: "transaction hash + output index"
 * is BTC's flavor of the disambiguating identity). No network I/O here,
 * which is what makes this trivially unit-testable against fixture JSON.
 */
export function mapEsploraTxToDeposits(tx: EsploraTx, watched: WatchedAddress, tipHeight: number): RawChainDeposit[] {
  const confirmations = tx.status.confirmed && tx.status.block_height != null ? tipHeight - tx.status.block_height + 1 : 0;

  const deposits: RawChainDeposit[] = [];
  tx.vout.forEach((output, index) => {
    if (output.scriptpubkey_address !== watched.address) return;
    deposits.push({
      walletAddressId: watched.walletAddressId,
      txHash: tx.txid,
      eventIndex: index,
      amount: rawUnitsToDecimalString(BigInt(output.value), 8),
      confirmations: Math.max(confirmations, 0),
      rawProviderPayload: tx as unknown as Record<string, unknown>,
    });
  });
  return deposits;
}
