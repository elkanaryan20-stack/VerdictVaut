import type { AdminWithdrawal } from "@verdictvaut/shared-types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminWithdrawalsTable } from "../components/admin/AdminWithdrawalsTable";
import { renderWithQueryClient } from "../test-support/render";
import { useAuth } from "../lib/auth/auth-context";
import * as adminApi from "../lib/admin/api";

jest.mock("../lib/admin/api");
jest.mock("../lib/auth/auth-context", () => ({ useAuth: jest.fn() }));

const mockedApi = adminApi as jest.Mocked<typeof adminApi>;
const mockedUseAuth = useAuth as jest.Mock;

const asset = { id: "asset-1", symbol: "USDC" as const, name: "USD Coin", decimals: 6, assetClass: "TOKEN" as const, isSettlementCurrency: true, isActive: true };
const network = { id: "network-1", code: "ethereum-sepolia", family: "EVM" as const, environment: "SANDBOX" as const, name: "Ethereum Sepolia", isActive: true };

function withdrawal(overrides: Partial<AdminWithdrawal> = {}): AdminWithdrawal {
  return {
    id: "wd-1",
    userId: "user-1",
    assetNetworkId: "an-1",
    destinationAddress: "0xDestinationAddress1234567890",
    destinationTag: null,
    amount: "50",
    fee: "0",
    status: "RISK_REVIEW",
    txHash: null,
    custodyReference: null,
    broadcastByAdminId: null,
    broadcastAt: null,
    confirmedAt: null,
    failureReason: null,
    complianceDecision: "DEFERRED",
    complianceNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    user: { id: "user-1", email: "trader@example.com" },
    assetNetwork: { id: "an-1", asset, network },
    ...overrides,
  };
}

describe("AdminWithdrawalsTable", () => {
  it("shows an empty state when there are no withdrawals", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "ADMIN" } });
    mockedApi.fetchAdminWithdrawals.mockResolvedValue([]);
    renderWithQueryClient(<AdminWithdrawalsTable />);
    expect(await screen.findByText("No withdrawals have been requested yet.")).toBeInTheDocument();
  });

  it("never shows Approve/Reject/Reconcile controls for a plain ADMIN — the backend also enforces this, but the UI shouldn't offer it", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "ADMIN" } });
    mockedApi.fetchAdminWithdrawals.mockResolvedValue([withdrawal({ status: "RISK_REVIEW" }), withdrawal({ id: "wd-2", status: "BROADCAST", txHash: "0xabc" })]);
    renderWithQueryClient(<AdminWithdrawalsTable />);
    await screen.findAllByText("trader@example.com");
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconcile" })).not.toBeInTheDocument();
  });

  it("offers Approve for a withdrawal pending review, but not for one already approved", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    mockedApi.fetchAdminWithdrawals.mockResolvedValue([withdrawal({ id: "wd-1", status: "RISK_REVIEW" }), withdrawal({ id: "wd-2", status: "APPROVED" })]);
    renderWithQueryClient(<AdminWithdrawalsTable />);
    await screen.findAllByText("trader@example.com");
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
  });

  it("still offers Reject for a withdrawal that has already been approved but not yet broadcast", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    mockedApi.fetchAdminWithdrawals.mockResolvedValue([withdrawal({ status: "APPROVED" })]);
    renderWithQueryClient(<AdminWithdrawalsTable />);
    expect(await screen.findByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("a SUPER_ADMIN approving a withdrawal sees a confirmation dialog before anything is called", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    mockedApi.fetchAdminWithdrawals.mockResolvedValue([withdrawal()]);
    const user = userEvent.setup();
    renderWithQueryClient(<AdminWithdrawalsTable />);

    await user.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Approve this withdrawal?")).toBeInTheDocument();
    expect(mockedApi.approveWithdrawal).not.toHaveBeenCalled();
  });

  it("only calls approveWithdrawal after the dialog is confirmed", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    mockedApi.fetchAdminWithdrawals.mockResolvedValue([withdrawal()]);
    mockedApi.approveWithdrawal.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithQueryClient(<AdminWithdrawalsTable />);

    await user.click(await screen.findByRole("button", { name: "Approve" }));
    await user.click(await screen.findByRole("button", { name: "Approve withdrawal" }));

    expect(mockedApi.approveWithdrawal).toHaveBeenCalledWith("wd-1");
  });

  it("requires a non-empty reason before the Reject dialog's confirm button is enabled, and only then calls rejectWithdrawal", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    mockedApi.fetchAdminWithdrawals.mockResolvedValue([withdrawal()]);
    mockedApi.rejectWithdrawal.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderWithQueryClient(<AdminWithdrawalsTable />);

    await user.click(await screen.findByRole("button", { name: "Reject" }));
    const confirmButton = await screen.findByRole("button", { name: "Reject withdrawal" });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText("Reason"), "Fails sanctions screening");
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(mockedApi.rejectWithdrawal).toHaveBeenCalledWith("wd-1", "Fails sanctions screening");
  });

  it("only offers Reconcile once a transaction hash has actually been recorded", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    mockedApi.fetchAdminWithdrawals.mockResolvedValue([
      withdrawal({ id: "wd-1", status: "APPROVED", txHash: null }),
      withdrawal({ id: "wd-2", status: "BROADCAST", txHash: "0xabc123" }),
    ]);
    renderWithQueryClient(<AdminWithdrawalsTable />);
    await waitFor(() => expect(screen.getAllByText("trader@example.com")).toHaveLength(2));
    expect(screen.getAllByRole("button", { name: "Reconcile" })).toHaveLength(1);
  });

  it("shows the real reconcile report returned by the backend, including a flagged discrepancy — never a fabricated success", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    mockedApi.fetchAdminWithdrawals.mockResolvedValue([withdrawal({ status: "BROADCAST", txHash: "0xabc123" })]);
    mockedApi.reconcileWithdrawal.mockResolvedValue({
      withdrawal: withdrawal({ status: "BROADCAST", txHash: "0xabc123" }),
      chainStatus: null,
      discrepancy: true,
      note: "Internal state claims this transaction broadcast, but it was not found on-chain.",
    });
    const user = userEvent.setup();
    renderWithQueryClient(<AdminWithdrawalsTable />);

    await user.click(await screen.findByRole("button", { name: "Reconcile" }));

    expect(mockedApi.reconcileWithdrawal).toHaveBeenCalledWith("wd-1");
    expect(await screen.findByText("Internal state claims this transaction broadcast, but it was not found on-chain.")).toBeInTheDocument();
  });

  it("never shows one withdrawal's reconcile report under a different withdrawal's row when two reconcile calls resolve out of order", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "SUPER_ADMIN" } });
    const wdA = withdrawal({ id: "wd-A", status: "BROADCAST", txHash: "0xaaa", user: { id: "user-1", email: "trader-a@example.com" } });
    const wdB = withdrawal({ id: "wd-B", status: "BROADCAST", txHash: "0xbbb", user: { id: "user-2", email: "trader-b@example.com" } });
    mockedApi.fetchAdminWithdrawals.mockResolvedValue([wdA, wdB]);

    let resolveA!: (value: Awaited<ReturnType<typeof adminApi.reconcileWithdrawal>>) => void;
    mockedApi.reconcileWithdrawal.mockImplementation((withdrawalId) => {
      if (withdrawalId === "wd-A") {
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve({ withdrawal: wdB, chainStatus: null, discrepancy: false, note: null });
    });

    const user = userEvent.setup();
    renderWithQueryClient(<AdminWithdrawalsTable />);
    await screen.findByText("trader-a@example.com");

    // Reconcile A first (stays pending), then reconcile B before A resolves.
    const reconcileButtons = screen.getAllByRole("button", { name: "Reconcile" });
    await user.click(reconcileButtons[0]);
    await user.click(reconcileButtons[1]);

    // B's fast, non-discrepant result must render only under B, never under A.
    await waitFor(() => expect(mockedApi.reconcileWithdrawal).toHaveBeenCalledWith("wd-B"));
    expect(screen.queryByText(/Internal state claims/)).not.toBeInTheDocument();

    // A's stale, discrepant result now finally resolves — it must never be
    // attributed to B's row (the row most recently clicked).
    resolveA({
      withdrawal: wdA,
      chainStatus: null,
      discrepancy: true,
      note: "Internal state claims this transaction broadcast, but it was not found on-chain.",
    });
    await new Promise((r) => setTimeout(r, 0));

    const trBRow = screen.getByText("trader-b@example.com").closest("div.items-start.justify-between");
    expect(trBRow).not.toHaveTextContent(/Internal state claims/);
  });

  it("shows an error state on API failure", async () => {
    mockedUseAuth.mockReturnValue({ user: { role: "ADMIN" } });
    mockedApi.fetchAdminWithdrawals.mockRejectedValue(new Error("network down"));
    renderWithQueryClient(<AdminWithdrawalsTable />);
    expect(await screen.findByText("Couldn't load withdrawals.")).toBeInTheDocument();
  });
});
