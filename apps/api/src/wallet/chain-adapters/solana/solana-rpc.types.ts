/** Minimal Solana JSON-RPC shapes — only the fields these adapters actually read. */
export interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface SolanaTransactionMeta {
  err: unknown | null;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: SolanaTokenBalance[];
  postTokenBalances?: SolanaTokenBalance[];
  // Present on v0 (versioned) transactions that reference an Address
  // Lookup Table — accounts resolved this way are NOT included in
  // transaction.message.accountKeys, yet preBalances/postBalances and
  // every token balance's accountIndex ARE indexed against the combined
  // list: message.accountKeys, then loadedAddresses.writable, then
  // loadedAddresses.readonly (this exact order is part of Solana's
  // JSON-RPC contract). Omitting this made the deposit identity/matching
  // silently blind to any deposit landing on an ALT-resolved account —
  // see combinedAccountKeys() in solana-tx.mapper.ts.
  loadedAddresses?: { writable: string[]; readonly: string[] };
}

export interface SolanaTransaction {
  slot: number;
  transaction: { message: { accountKeys: string[] } };
  meta: SolanaTransactionMeta | null;
}

export interface SolanaSignatureInfo {
  signature: string;
}
