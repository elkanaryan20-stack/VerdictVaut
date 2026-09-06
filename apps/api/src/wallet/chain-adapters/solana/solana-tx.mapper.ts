import { rawUnitsToDecimalString } from "../decimal-units.util";
import { RawChainDeposit, WatchedAddress } from "../deposit-chain-adapter.interface";
import { SolanaTransaction } from "./solana-rpc.types";

/**
 * Solana confirmation depth has no single universal "confirmations"
 * field the way a block-height chain does — this uses slot depth
 * (currentSlot - transaction slot) as the standard proxy, which is what
 * AssetNetwork.minConfirmations for solana-devnet (32, in the seed) is
 * calibrated against.
 */
function confirmationsFromSlot(txSlot: number, currentSlot: number): number {
  return Math.max(currentSlot - txSlot, 0);
}

function byAddress(watched: WatchedAddress[]): Map<string, WatchedAddress> {
  // Base58 Solana addresses are case-sensitive — never lowercase them.
  return new Map(watched.map((w) => [w.address, w]));
}

/**
 * The account list preBalances/postBalances/tokenBalance.accountIndex
 * are actually indexed against — NOT just transaction.message.accountKeys.
 *
 * A v0 (versioned) transaction that references an Address Lookup Table
 * resolves additional accounts that never appear in message.accountKeys
 * at all; Solana's JSON-RPC contract defines the combined index space as
 * [ ...message.accountKeys, ...meta.loadedAddresses.writable,
 * ...meta.loadedAddresses.readonly ]. Using message.accountKeys alone
 * (as an earlier version of this mapper did) silently misses any
 * deposit landing on an ALT-resolved account: the index would either be
 * out of bounds (undefined, never matches) or — worse — could
 * coincidentally collide with an unrelated account if a caller assumed
 * array bounds sloppily. Legacy transactions simply have no
 * loadedAddresses, so this is a no-op extension for them.
 */
function combinedAccountKeys(tx: SolanaTransaction): string[] {
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return tx.transaction.message.accountKeys;
  return [...tx.transaction.message.accountKeys, ...loaded.writable, ...loaded.readonly];
}

/**
 * Pure mapping for native SOL: a transaction's account-balance deltas
 * (lamports) tell us exactly what each account gained or lost, and the
 * account's own index in the combined account-key list (see
 * combinedAccountKeys) is unique within the transaction — safe to use as
 * eventIndex even when the same transaction happens to credit more than
 * one watched address at once.
 */
export function mapNativeSolTransactionToDeposits(
  signature: string,
  tx: SolanaTransaction,
  watched: WatchedAddress[],
  currentSlot: number,
  decimals: number,
): RawChainDeposit[] {
  if (!tx.meta || tx.meta.err) return [];

  const watchedByAddress = byAddress(watched);
  const accountKeys = combinedAccountKeys(tx);
  const confirmations = confirmationsFromSlot(tx.slot, currentSlot);

  const deposits: RawChainDeposit[] = [];
  accountKeys.forEach((address, index) => {
    const match = watchedByAddress.get(address);
    if (!match) return;
    const delta = tx.meta!.postBalances[index] - tx.meta!.preBalances[index];
    if (delta <= 0) return;

    deposits.push({
      walletAddressId: match.walletAddressId,
      txHash: signature,
      eventIndex: index,
      amount: rawUnitsToDecimalString(BigInt(delta), decimals),
      confirmations,
      rawProviderPayload: tx as unknown as Record<string, unknown>,
    });
  });
  return deposits;
}

/**
 * Pure mapping for SPL token transfers: compares pre/post token-account
 * balances for the specific mint this AssetNetwork tracks. `watched`
 * addresses are the token *account* (ATA) addresses themselves — the
 * deposit-address-pool model treats them the same as any other
 * dedicated per-user deposit address. eventIndex is the token account's
 * accountIndex as reported by the RPC, which — like the native case —
 * is relative to the combined account-key list (see
 * combinedAccountKeys), not just message.accountKeys.
 */
export function mapSplTokenTransactionToDeposits(
  signature: string,
  tx: SolanaTransaction,
  watched: WatchedAddress[],
  currentSlot: number,
  mint: string,
  fallbackDecimals: number,
): RawChainDeposit[] {
  if (!tx.meta || tx.meta.err) return [];

  const watchedByAddress = byAddress(watched);
  const accountKeys = combinedAccountKeys(tx);
  const confirmations = confirmationsFromSlot(tx.slot, currentSlot);
  const preByIndex = new Map((tx.meta.preTokenBalances ?? []).map((b) => [b.accountIndex, b]));

  const deposits: RawChainDeposit[] = [];
  for (const post of tx.meta.postTokenBalances ?? []) {
    if (post.mint !== mint) continue;
    const address = accountKeys[post.accountIndex];
    const match = watchedByAddress.get(address);
    if (!match) continue;

    const pre = preByIndex.get(post.accountIndex);
    const preAmount = BigInt(pre?.uiTokenAmount.amount ?? "0");
    const postAmount = BigInt(post.uiTokenAmount.amount);
    const delta = postAmount - preAmount;
    if (delta <= 0n) continue;

    deposits.push({
      walletAddressId: match.walletAddressId,
      txHash: signature,
      eventIndex: post.accountIndex,
      amount: rawUnitsToDecimalString(delta, post.uiTokenAmount.decimals || fallbackDecimals),
      confirmations,
      rawProviderPayload: tx as unknown as Record<string, unknown>,
    });
  }
  return deposits;
}
