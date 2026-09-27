import type { AdminWithdrawal } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import { OperationsStatus } from "../components/admin/OperationsStatus";
import { ApiError } from "../lib/api-client";
import * as adminApi from "../lib/admin/api";
import { renderWithQueryClient } from "../test-support/render";

jest.mock("../lib/admin/api");
const mockedApi = adminApi as jest.Mocked<typeof adminApi>;

const asset = { id: "asset-1", symbol: "USDC" as const, name: "USD Coin", decimals: 6, assetClass: "TOKEN" as const, isSettlementCurrency: true, isActive: true };
const network = { id: "network-1", code: "ethereum-sepolia", family: "EVM" as const, environment: "SANDBOX" as const, name: "Ethereum Sepolia", isActive: true };

function staleWithdrawal(overrides: Partial<AdminWithdrawal> = {}): AdminWithdrawal {
  return {
    id: "wd-stuck-1",
    userId: "user-1",
    assetNetworkId: "an-1",
    destinationAddress: "0xabc",
    destinationTag: null,
    amount: "250",
    fee: "0",
    status: "EXECUTION_AMBIGUOUS",
    txHash: null,
    custodyReference: null,
    broadcastByAdminId: null,
    broadcastAt: null,
    confirmedAt: null,
    failureReason: null,
    complianceDecision: "DEFERRED",
    complianceNote: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    user: { id: "user-1", email: "trader@example.com" },
    assetNetwork: { id: "an-1", asset, network },
    ...overrides,
  };
}

describe("OperationsStatus (Phase 36 — read-only Phase 35 operational views)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("lists stale withdrawals (including EXECUTION_AMBIGUOUS), job health, and open discrepancies — with no action controls", async () => {
    mockedApi.fetchStaleWithdrawals.mockResolvedValue([staleWithdrawal()]);
    mockedApi.fetchScheduledJobs.mockResolvedValue([
      {
        jobKey: "withdrawal-watcher",
        lockedAt: null,
        lockedBy: null,
        lastStartedAt: "2026-09-27T10:00:00.000Z",
        lastSuccessAt: "2026-09-27T09:00:00.000Z",
        lastErrorAt: "2026-09-27T10:00:01.000Z",
        lastError: "database unreachable",
        lastSummary: null,
        updatedAt: "2026-09-27T10:00:01.000Z",
      },
      {
        jobKey: "collateral-reconciliation",
        lockedAt: null,
        lockedBy: null,
        lastStartedAt: "2026-09-27T10:00:00.000Z",
        lastSuccessAt: "2026-09-27T10:00:02.000Z",
        lastErrorAt: null,
        lastError: null,
        lastSummary: "checked=3 discrepancies=0 truncated=false",
        updatedAt: "2026-09-27T10:00:02.000Z",
      },
    ]);
    mockedApi.fetchOpenDiscrepancies.mockResolvedValue([
      {
        id: "d-1",
        type: "withdrawal_chain_mismatch",
        severity: "CRITICAL",
        status: "OPEN",
        chainIdentity: "0xhash",
        assetNetworkId: "an-1",
        marketId: null,
        internalEntityType: "Withdrawal",
        internalEntityId: "wd-9",
        createdAt: "2026-09-27T10:00:00.000Z",
      },
    ]);

    renderWithQueryClient(<OperationsStatus />);

    await waitFor(() => expect(screen.getByText("Under verification")).toBeInTheDocument());
    expect(screen.getByText(/trader@example.com/)).toBeInTheDocument();
    // Status is spelled out in text, never color alone.
    expect(await screen.findByText("Last run failed")).toBeInTheDocument();
    expect(screen.getByText("database unreachable")).toBeInTheDocument();
    expect(screen.getByText("Last run succeeded")).toBeInTheDocument();
    expect(await screen.findByText("withdrawal chain mismatch")).toBeInTheDocument();
    expect(screen.getByText("CRITICAL")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("shows explicit empty states, including when no background job has ever reported", async () => {
    mockedApi.fetchStaleWithdrawals.mockResolvedValue([]);
    mockedApi.fetchScheduledJobs.mockResolvedValue([]);
    mockedApi.fetchOpenDiscrepancies.mockResolvedValue([]);
    renderWithQueryClient(<OperationsStatus />);
    expect(await screen.findByText("No stale withdrawals.")).toBeInTheDocument();
    expect(await screen.findByText(/No background job has reported yet/)).toBeInTheDocument();
    expect(await screen.findByText("No open discrepancies.")).toBeInTheDocument();
  });

  it("explains a 403 rather than showing a blank panel", async () => {
    mockedApi.fetchStaleWithdrawals.mockRejectedValue(new ApiError(403, "Forbidden"));
    mockedApi.fetchScheduledJobs.mockResolvedValue([]);
    mockedApi.fetchOpenDiscrepancies.mockResolvedValue([]);
    renderWithQueryClient(<OperationsStatus />);
    expect(await screen.findByText(/Your role does not have access to this view/)).toBeInTheDocument();
  });
});
