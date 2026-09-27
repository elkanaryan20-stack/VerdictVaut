import { Prisma, Withdrawal, WithdrawalStatus } from "@prisma/client";
import { toUserWithdrawalView } from "./user-withdrawal-view";
import { WithdrawalsController } from "./withdrawals.controller";

function row(overrides: Partial<Withdrawal> = {}): Withdrawal {
  return {
    id: "wd-1",
    userId: "u-1",
    assetNetworkId: "an-1",
    sourceWalletAddressId: null,
    destinationAddress: "0xabc",
    destinationTag: null,
    amount: new Prisma.Decimal(10),
    fee: new Prisma.Decimal(0),
    status: WithdrawalStatus.RISK_REVIEW,
    clientWithdrawalId: "c-1",
    txHash: null,
    custodyReference: "fb-tx-123",
    broadcastByAdminId: "admin-9",
    broadcastAt: null,
    confirmedAt: null,
    failureReason: null,
    complianceDecision: "DEFERRED",
    complianceNote: "Elliptic address-risk screening: MEDIUM (analysis abc) — pending mandatory human SUPER_ADMIN review.",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("toUserWithdrawalView (Phase 36)", () => {
  it("never exposes compliance notes, provider references, or internal admin ids to the owner", () => {
    const view = toUserWithdrawalView(row());
    expect(view.complianceNote).toBeNull();
    expect(view.custodyReference).toBeNull();
    expect(view.broadcastByAdminId).toBeNull();
    expect(view.complianceDecision).toBe("DEFERRED");
    expect(view.amount.toString()).toBe("10");
  });

  it("shows failureReason only once the withdrawal actually FAILED or was REJECTED", () => {
    expect(toUserWithdrawalView(row({ status: "REJECTED", failureReason: "Destination is a known scam address" })).failureReason).toBe("Destination is a known scam address");
    expect(toUserWithdrawalView(row({ status: "FAILED", failureReason: "Broadcast transaction failed on-chain." })).failureReason).toBe("Broadcast transaction failed on-chain.");
    expect(toUserWithdrawalView(row({ status: "EXECUTION_AMBIGUOUS", failureReason: "Declared execution-ambiguous by SUPER_ADMIN: internal note" })).failureReason).toBeNull();
    expect(toUserWithdrawalView(row({ status: "CREDITED", failureReason: "Fireblocks returned a server error (HTTP 503)." })).failureReason).toBeNull();
  });

  it("is applied by every user-facing WithdrawalsController route", async () => {
    const internal = row();
    const service = {
      request: jest.fn().mockResolvedValue(internal),
      listMine: jest.fn().mockResolvedValue([internal]),
      getOwned: jest.fn().mockResolvedValue(internal),
      cancel: jest.fn().mockResolvedValue(internal),
    };
    const controller = new WithdrawalsController(service as never);
    const user = { id: "u-1" } as never;

    const results = [
      await controller.request(user, {} as never),
      ...(await controller.listMine(user)),
      await controller.getMine(user, "wd-1"),
      await controller.cancel(user, "wd-1"),
    ];
    for (const result of results) {
      expect(result.complianceNote).toBeNull();
      expect(result.custodyReference).toBeNull();
    }
  });
});
