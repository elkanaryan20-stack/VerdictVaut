import { z } from "zod";
import { NETWORK_ENVIRONMENTS, NETWORK_FAMILIES, SUPPORTED_ASSET_SYMBOLS } from "./assets";

/**
 * Shapes mirroring the backend's actual API responses for the wallet/
 * deposit domain (see apps/api/src/wallet/**). These are read/response
 * schemas, not request-validation duplicates of the backend's own DTOs —
 * the backend remains the single source of truth for what it accepts;
 * this is what the frontend can safely assume it receives back.
 */

export const AssetClassSchema = z.enum(["NATIVE", "TOKEN"]);
export type AssetClass = z.infer<typeof AssetClassSchema>;

export const AssetSchema = z.object({
  id: z.string(),
  symbol: z.enum(SUPPORTED_ASSET_SYMBOLS),
  name: z.string(),
  decimals: z.number().int().nonnegative(),
  assetClass: AssetClassSchema,
  isSettlementCurrency: z.boolean(),
  isActive: z.boolean(),
});
export type Asset = z.infer<typeof AssetSchema>;

export const NetworkSchema = z.object({
  id: z.string(),
  code: z.string(),
  family: z.enum(NETWORK_FAMILIES),
  environment: z.enum(NETWORK_ENVIRONMENTS),
  name: z.string(),
  isActive: z.boolean(),
});
export type Network = z.infer<typeof NetworkSchema>;

/**
 * An asset+network combination is the actual unit of "what can I deposit,
 * on what network, and under what rules" — never assume one asset has a
 * single universal network (see AssetNetwork.contractAddress /
 * memoRequired, which vary per pair, not per asset).
 */
export const AssetNetworkSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  networkId: z.string(),
  isNative: z.boolean(),
  contractAddress: z.string().nullable(),
  memoRequired: z.boolean(),
  minConfirmations: z.number().int().nonnegative(),
  depositMinAmount: z.string(),
  withdrawalMinAmount: z.string(),
  isActive: z.boolean(),
  asset: AssetSchema,
  network: NetworkSchema,
});
export type AssetNetworkView = z.infer<typeof AssetNetworkSchema>;

export const WalletAddressSchema = z.object({
  id: z.string(),
  address: z.string(),
  destinationTag: z.string().nullable(),
  environment: z.enum(NETWORK_ENVIRONMENTS),
});
export type WalletAddress = z.infer<typeof WalletAddressSchema>;

/** One user's dedicated deposit address for one asset+network pair. */
export const DepositAddressAssignmentSchema = z.object({
  id: z.string(),
  userId: z.string(),
  assetId: z.string(),
  networkId: z.string(),
  assetNetworkId: z.string(),
  walletAddressId: z.string(),
  destinationTag: z.string().nullable(),
  environment: z.enum(NETWORK_ENVIRONMENTS),
  assignedAt: z.string(),
  walletAddress: WalletAddressSchema,
  asset: AssetSchema.optional(),
  network: NetworkSchema.optional(),
});
export type DepositAddressAssignment = z.infer<typeof DepositAddressAssignmentSchema>;

/**
 * PENDING covers both "just detected" and "accumulating confirmations" —
 * see Deposit.confirmations for progress within that status. REJECTED
 * (chain invalidated it, e.g. a reorg) is terminal and distinct from
 * FAILED (a processing-side problem, e.g. a destination-tag mismatch) —
 * never collapse the two in the UI.
 */
export const DEPOSIT_STATUSES = ["PENDING", "CONFIRMED", "CREDITED", "REJECTED", "FAILED"] as const;
export const DepositStatusSchema = z.enum(DEPOSIT_STATUSES);
export type DepositStatus = z.infer<typeof DepositStatusSchema>;

export const AssetNetworkRefSchema = z.object({
  id: z.string(),
  contractAddress: z.string().nullable().optional(),
  memoRequired: z.boolean().optional(),
  minConfirmations: z.number().int().nonnegative().optional(),
  asset: AssetSchema,
  network: NetworkSchema,
});

export const DepositSchema = z.object({
  id: z.string(),
  userId: z.string(),
  assetId: z.string(),
  assetNetworkId: z.string(),
  walletAddressId: z.string(),
  txHash: z.string(),
  eventIndex: z.number().int().nonnegative(),
  amount: z.string(),
  confirmations: z.number().int().nonnegative(),
  requiredConfirmations: z.number().int().nonnegative(),
  status: DepositStatusSchema,
  destinationTag: z.string().nullable(),
  failureReason: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
  ledgerTransactionId: z.string().nullable(),
  detectedAt: z.string(),
  lastCheckedAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  creditedAt: z.string().nullable(),
  // Only present on the single-deposit detail endpoint, not the list one.
  assetNetwork: AssetNetworkRefSchema.optional(),
});
export type Deposit = z.infer<typeof DepositSchema>;

export const PaginatedDepositsSchema = z.object({
  items: z.array(DepositSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type PaginatedDeposits = z.infer<typeof PaginatedDepositsSchema>;

/**
 * Per-asset balance view — GET /wallet/balances. Covers every active
 * asset (see SUPPORTED_ASSET_SYMBOLS), zero-filled for one the user has
 * never touched — never a fabricated non-zero figure. Multi-asset
 * balances are never summed into one blended figure (no price/FX
 * conversion exists in this system) — "total" here means this asset's
 * own total, not a portfolio-wide number.
 */
/**
 * Withdrawal lifecycle — see apps/api WithdrawalsService's own docblock
 * for the full state-machine diagram. REQUESTED never actually persists
 * as an externally-observable status (reservation happens atomically
 * with creation — see request()); CANCELLED is user-initiated (only
 * reachable before SUPER_ADMIN review begins), REJECTED/FAILED are
 * admin/system-initiated.
 */
export const WITHDRAWAL_STATUSES = [
  "REQUESTED",
  "VALIDATED",
  "RISK_REVIEW",
  "APPROVED",
  "PENDING_MANUAL_BROADCAST",
  "BROADCASTING",
  "BROADCAST",
  "CONFIRMING",
  "CONFIRMED",
  "CREDITED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
] as const;
export const WithdrawalStatusSchema = z.enum(WITHDRAWAL_STATUSES);
export type WithdrawalStatus = z.infer<typeof WithdrawalStatusSchema>;

/**
 * The honest result of the backend's WithdrawalComplianceGate at request
 * time — DEFERRED (the current default) means no real KYC/AML/sanctions
 * system is wired up yet; it is never rendered as "approved".
 */
export const WithdrawalComplianceDecisionSchema = z.enum(["PASS", "BLOCKED", "DEFERRED"]);
export type WithdrawalComplianceDecision = z.infer<typeof WithdrawalComplianceDecisionSchema>;

export const WithdrawalSchema = z.object({
  id: z.string(),
  userId: z.string(),
  assetNetworkId: z.string(),
  destinationAddress: z.string(),
  destinationTag: z.string().nullable(),
  amount: z.string(),
  fee: z.string(),
  status: WithdrawalStatusSchema,
  txHash: z.string().nullable(),
  custodyReference: z.string().nullable(),
  broadcastByAdminId: z.string().nullable(),
  broadcastAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  complianceDecision: WithdrawalComplianceDecisionSchema.nullable(),
  complianceNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Populated on every user- and admin-facing read endpoint (never on
  // the raw row alone) — see WithdrawalsService.getById/getOwned/listMine.
  assetNetwork: AssetNetworkRefSchema.optional(),
});
export type Withdrawal = z.infer<typeof WithdrawalSchema>;

/**
 * GET /admin/withdrawals/:id/reconcile's result — a fresh, real
 * comparison of internal state against on-chain evidence via
 * CustodyProvider, never a cached figure. Read + audit only: this never
 * represents a mutation, and `discrepancy` is the one honest, narrow
 * signal the backend computes (see WithdrawalsService.reconcile's
 * docblock) — never an auto-fix.
 */
export const ChainTransactionStatusSchema = z.object({
  txHash: z.string(),
  assetNetworkId: z.string(),
  confirmations: z.number().int().nonnegative(),
  amount: z.string(),
  status: z.enum(["not_found", "pending", "confirmed"]),
});
export type ChainTransactionStatus = z.infer<typeof ChainTransactionStatusSchema>;

export const WithdrawalReconcileResultSchema = z.object({
  withdrawal: WithdrawalSchema,
  chainStatus: ChainTransactionStatusSchema.nullable(),
  discrepancy: z.boolean(),
  note: z.string().nullable(),
});
export type WithdrawalReconcileResult = z.infer<typeof WithdrawalReconcileResultSchema>;

export const AssetBalanceSchema = z.object({
  assetId: z.string(),
  symbol: z.enum(SUPPORTED_ASSET_SYMBOLS),
  name: z.string(),
  decimals: z.number().int().nonnegative(),
  assetClass: AssetClassSchema,
  totalBalance: z.string(),
  reservedBalance: z.string(),
  availableBalance: z.string(),
});
export type AssetBalance = z.infer<typeof AssetBalanceSchema>;
