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
