import {
  AssetBalance,
  AssetBalanceSchema,
  AssetNetworkSchema,
  AssetNetworkView,
  Deposit,
  DepositAddressAssignment,
  DepositAddressAssignmentSchema,
  DepositSchema,
  PaginatedDeposits,
  PaginatedDepositsSchema,
} from "@verdictvaut/shared-types";
import { z } from "zod";
import { apiFetch } from "../api-client";

export class MalformedResponseError extends Error {
  constructor(context: string, issues: string) {
    super(`Unexpected data shape from the server (${context}): ${issues}`);
    this.name = "MalformedResponseError";
  }
}

/**
 * Every response the wallet UI treats as financial fact is validated
 * against the shared Zod schema before anything renders it — a
 * malformed or unexpectedly-shaped backend response surfaces as a clear
 * "something went wrong" error state, never as a silently wrong number
 * on screen or a raw runtime crash deep in a component.
 */
function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new MalformedResponseError(context, result.error.issues.map((issue) => issue.message).join("; "));
  }
  return result.data;
}

export async function fetchBalances(): Promise<AssetBalance[]> {
  const data = await apiFetch<unknown>("/wallet/balances");
  return parseOrThrow(z.array(AssetBalanceSchema), data, "GET /wallet/balances");
}

export async function fetchAssetNetworks(): Promise<AssetNetworkView[]> {
  const data = await apiFetch<unknown>("/wallet/asset-networks");
  return parseOrThrow(z.array(AssetNetworkSchema), data, "GET /wallet/asset-networks");
}

export async function fetchMyDepositAddresses(): Promise<DepositAddressAssignment[]> {
  const data = await apiFetch<unknown>("/wallet/deposits/addresses");
  return parseOrThrow(z.array(DepositAddressAssignmentSchema), data, "GET /wallet/deposits/addresses");
}

export async function assignDepositAddress(assetSymbol: string, networkCode: string): Promise<DepositAddressAssignment> {
  const data = await apiFetch<unknown>("/wallet/deposits/addresses", {
    method: "POST",
    body: JSON.stringify({ assetSymbol, networkCode }),
  });
  return parseOrThrow(DepositAddressAssignmentSchema, data, "POST /wallet/deposits/addresses");
}

export async function fetchDeposits(page: number, pageSize: number): Promise<PaginatedDeposits> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const data = await apiFetch<unknown>(`/wallet/deposits?${params.toString()}`);
  return parseOrThrow(PaginatedDepositsSchema, data, "GET /wallet/deposits");
}

export async function fetchDeposit(depositId: string): Promise<Deposit> {
  const data = await apiFetch<unknown>(`/wallet/deposits/${depositId}`);
  return parseOrThrow(DepositSchema, data, "GET /wallet/deposits/:id");
}
