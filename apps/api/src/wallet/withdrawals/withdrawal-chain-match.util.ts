import { Prisma, Withdrawal } from "@prisma/client";
import { ChainTransactionStatus } from "../custody/custody-provider.interface";

// Extracted from withdrawals.service.ts in Phase 35 (unchanged logic) so
// IndependentReconciliationService's scheduled withdrawal check applies
// exactly the same destination/amount rule as recordConfirmation() and
// reconcile() — the automatic, manual and scheduled paths can never
// disagree on what counts as a mismatch.

// Pure floating/rounding slack, not a real discrepancy allowance — mirrors ReconciliationService's own RECONCILIATION_TOLERANCE.
export const WITHDRAWAL_RECONCILE_AMOUNT_TOLERANCE = new Prisma.Decimal("0.000000000000000001");

/** The subset of ChainTransactionStatus the destination/amount mismatch check needs — see findChainMismatch. */
export type ObservedChainTransaction = Pick<ChainTransactionStatus, "amount" | "destinationAddress" | "outputs" | "destinationTag">;

/**
 * EVM hex addresses are case-insensitive (EIP-55 checksum casing is a
 * display convention, not a distinct address) — compared lowercased.
 * XRP base58 addresses ARE case-sensitive; compared exactly. Detecting
 * "looks like an EVM address" by its 0x prefix avoids needing to thread
 * the network family into reconcile() just for this comparison.
 */
export function destinationsMatch(observed: string, recorded: string): boolean {
  if (observed.startsWith("0x") && recorded.startsWith("0x")) {
    return observed.toLowerCase() === recorded.toLowerCase();
  }
  // Phase 34 — bech32/bech32m (BIP-173) addresses are case-insensitive
  // too (a user may legitimately submit the all-uppercase QR form, while
  // Esplora always reports lowercase); Base58 legacy/P2SH addresses are
  // not, and still fall through to the exact comparison below.
  if (BECH32_BITCOIN_PREFIX.test(observed) && BECH32_BITCOIN_PREFIX.test(recorded)) {
    return observed.toLowerCase() === recorded.toLowerCase();
  }
  return observed === recorded;
}

const BECH32_BITCOIN_PREFIX = /^(bc1|tb1|bcrt1)/i;

/**
 * Requirement #12/#13 ("verify destination/amount where practical") — the
 * one comparison shared by reconcile() (manual, SUPER_ADMIN-triggered) and
 * recordConfirmation() (automatic, watcher-triggered, Phase 33). Only
 * called once the chain already shows real activity (confirmed/pending) —
 * a genuine mismatch means the broadcast transaction that actually exists
 * on-chain paid a different address or amount than this withdrawal
 * recorded, e.g. from an admin's manually-typed txHash
 * (recordManualBroadcast/resolveAmbiguousExecution never verify their
 * input on-chain by design) or a provider-side error.
 */
export function findChainMismatch(withdrawal: Withdrawal, chainStatus: ObservedChainTransaction): string | null {
  if (chainStatus.destinationAddress && !destinationsMatch(chainStatus.destinationAddress, withdrawal.destinationAddress)) {
    // Requirement #12/#13: "verify destination where practical". Only
    // checked when the provider actually reports one (EVM/XRP today —
    // see ChainTransactionStatus's own docblock for why Bitcoin/Solana
    // don't) — a genuine mismatch here would mean the broadcast paid a
    // DIFFERENT address than the one this withdrawal recorded.
    return "The broadcast transaction's on-chain destination does not match this withdrawal's recorded destination address.";
  }
  // Phase 41 (R2) — on XRPL an exchange/custodial destination address is
  // shared by many customers and the tag selects the beneficiary: the right
  // address with the wrong (or a missing) tag pays someone else. Only
  // checked when the provider reports tags (`undefined` = not applicable).
  if (chainStatus.destinationTag !== undefined && (withdrawal.destinationTag ?? null) !== chainStatus.destinationTag) {
    return "The broadcast transaction's on-chain destination tag does not match this withdrawal's recorded destination tag.";
  }
  // The amount actually delivered on-chain should equal amount - fee (see
  // request()'s own accounting docblock) — never `amount` alone.
  const expectedNet = withdrawal.amount.minus(withdrawal.fee);
  let observed = new Prisma.Decimal(chainStatus.amount);
  if (chainStatus.outputs) {
    // Phase 34 — Bitcoin: `amount` is the sum of EVERY output, which for
    // a real UTXO-wallet withdrawal includes the change output back to
    // the platform's own wallet — comparing it against expectedNet made
    // every change-bearing BTC withdrawal permanently uncreditable. Only
    // what was actually paid to this withdrawal's recorded destination
    // counts, which also gives Bitcoin the destination check it
    // previously had none of.
    const paid = chainStatus.outputs.filter((o) => destinationsMatch(o.address, withdrawal.destinationAddress));
    if (paid.length === 0) {
      return "The broadcast transaction has no output paying this withdrawal's recorded destination address.";
    }
    observed = paid.reduce((sum, o) => sum.plus(o.amount), new Prisma.Decimal(0));
  }
  if (observed.minus(expectedNet).abs().greaterThan(WITHDRAWAL_RECONCILE_AMOUNT_TOLERANCE)) {
    return `The broadcast transaction's on-chain amount (${observed.toString()}) does not match the expected net amount (${expectedNet.toString()}).`;
  }
  return null;
}
