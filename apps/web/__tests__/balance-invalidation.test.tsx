import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { Deposit } from "@verdictvaut/shared-types";
import { useBalances, useDeposit } from "../lib/wallet/hooks";
import * as walletApi from "../lib/wallet/api";

jest.mock("../lib/wallet/api");
const mockedApi = walletApi as jest.Mocked<typeof walletApi>;

function makeDeposit(status: Deposit["status"]): Deposit {
  return {
    id: "dep-1",
    userId: "user-1",
    assetId: "asset-1",
    assetNetworkId: "an-1",
    walletAddressId: "wa-1",
    txHash: "0xhash",
    eventIndex: 0,
    amount: "10",
    confirmations: status === "CREDITED" ? 12 : 3,
    requiredConfirmations: 12,
    status,
    destinationTag: null,
    failureReason: null,
    retryCount: 0,
    ledgerTransactionId: status === "CREDITED" ? "ltx-1" : null,
    detectedAt: new Date().toISOString(),
    lastCheckedAt: null,
    confirmedAt: null,
    creditedAt: status === "CREDITED" ? new Date().toISOString() : null,
  };
}

describe("balance invalidation on deposit credit", () => {
  it("refetches balances the moment a watched deposit transitions to CREDITED, not on every poll", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    mockedApi.fetchBalances.mockResolvedValue([]);
    mockedApi.fetchDeposit.mockResolvedValue(makeDeposit("PENDING"));

    const { result: balancesResult } = renderHook(() => useBalances(), { wrapper });
    const { result: depositResult } = renderHook(() => useDeposit("dep-1"), { wrapper });

    await waitFor(() => expect(balancesResult.current.isSuccess).toBe(true));
    await waitFor(() => expect(depositResult.current.isSuccess).toBe(true));

    expect(mockedApi.fetchBalances).toHaveBeenCalledTimes(1);

    // Still PENDING — a manual refetch must NOT invalidate balances.
    await depositResult.current.refetch();
    expect(mockedApi.fetchBalances).toHaveBeenCalledTimes(1);

    // Now it becomes CREDITED — this specific transition must invalidate balances.
    mockedApi.fetchDeposit.mockResolvedValue(makeDeposit("CREDITED"));
    await depositResult.current.refetch();

    await waitFor(() => expect(mockedApi.fetchBalances).toHaveBeenCalledTimes(2));

    // Once already CREDITED, a further refetch must not invalidate again.
    await depositResult.current.refetch();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockedApi.fetchBalances).toHaveBeenCalledTimes(2);
  });
});
