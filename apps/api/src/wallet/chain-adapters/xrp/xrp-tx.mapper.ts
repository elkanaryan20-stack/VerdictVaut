import { rawUnitsToDecimalString } from "../decimal-units.util";
import { RawChainDeposit, WatchedAddress } from "../deposit-chain-adapter.interface";
import { XrplAccountTxEntry } from "./xrpl-rpc.types";

/**
 * Pure mapping of one XRPL transaction-history entry to a deposit
 * observation. Deliberately handles only native-XRP Payment transactions
 * — `Amount`/`delivered_amount` as a plain drops string — never an
 * issued-currency object, since XRP is the only XRPL asset this platform
 * supports (see seed.ts). `delivered_amount` (not `Amount`) is used when
 * present because it reflects what the destination actually received,
 * which can differ from the sender-specified Amount for a partial
 * payment.
 *
 * eventIndex is always 0: a single XRP Payment has exactly one
 * Destination, so txHash alone already uniquely identifies the transfer
 * (see Deposit.eventIndex doc — native XRP transfers use the default).
 * The destination tag is a SEPARATE, always-preserved field: it
 * disambiguates which user a shared/tag-addressed deposit address
 * belongs to, but is never folded into eventIndex or used to skip
 * recording an observation — DepositsService is the one place that
 * decides whether a tag mismatch blocks crediting.
 */
export function mapXrplEntryToDeposit(
  entry: XrplAccountTxEntry,
  watched: WatchedAddress,
  currentValidatedLedger: number,
  decimals: number,
): RawChainDeposit | null {
  if (entry.tx.TransactionType !== "Payment") return null;
  if (entry.meta.TransactionResult !== "tesSUCCESS") return null;
  if (entry.tx.Destination !== watched.address) return null;

  const amount = entry.meta.delivered_amount ?? entry.tx.Amount;
  if (typeof amount !== "string") return null; // issued-currency payment — out of scope, never fabricate an XRP amount from it

  const confirmations = entry.validated ? Math.max(currentValidatedLedger - entry.tx.ledger_index + 1, 0) : 0;

  return {
    walletAddressId: watched.walletAddressId,
    txHash: entry.tx.hash,
    eventIndex: 0,
    amount: rawUnitsToDecimalString(amount, decimals),
    confirmations,
    destinationTag: entry.tx.DestinationTag != null ? String(entry.tx.DestinationTag) : undefined,
    rawProviderPayload: entry as unknown as Record<string, unknown>,
  };
}
