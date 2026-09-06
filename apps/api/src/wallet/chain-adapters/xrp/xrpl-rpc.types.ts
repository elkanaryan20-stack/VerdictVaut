/** Minimal XRPL JSON-RPC shapes — only the fields these adapters actually read. */
export interface XrplTxFields {
  TransactionType: string;
  Destination: string;
  Amount: string | Record<string, unknown>;
  DestinationTag?: number;
  hash: string;
  ledger_index: number;
}

export interface XrplTxMeta {
  TransactionResult: string;
  delivered_amount?: string | Record<string, unknown>;
}

/** A single entry as returned inside `account_tx`'s `transactions[]` array. */
export interface XrplAccountTxEntry {
  tx: XrplTxFields;
  meta: XrplTxMeta;
  validated: boolean;
}

export interface XrplAccountTxResult {
  transactions: XrplAccountTxEntry[];
}

/** The flat shape returned directly by the `tx` method (fields merged at the top level, unlike account_tx's nested `.tx`). */
export type XrplTxMethodResult = XrplTxFields & { meta: XrplTxMeta; validated: boolean };

export interface XrplServerInfoResult {
  info: { validated_ledger?: { seq: number } };
}

/** Normalizes either shape into one common record so the mapper only has one thing to handle. */
export function toAccountTxEntry(result: XrplTxMethodResult): XrplAccountTxEntry {
  return { tx: result, meta: result.meta, validated: result.validated };
}
