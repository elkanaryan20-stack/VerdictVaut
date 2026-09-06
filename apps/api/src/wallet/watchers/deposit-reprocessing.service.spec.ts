import { DepositReprocessingService } from "./deposit-reprocessing.service";

describe("DepositReprocessingService", () => {
  let prisma: { deposit: { findUniqueOrThrow: jest.Mock } };
  let adapterFactory: { resolve: jest.Mock };
  let confirmationPolicy: { getRequiredConfirmations: jest.Mock };
  let depositsService: { touchLastChecked: jest.Mock; rejectIfNotCredited: jest.Mock; recordObservedTransaction: jest.Mock };
  let auditLog: { record: jest.Mock };
  let service: DepositReprocessingService;

  const depositRow = {
    id: "dep-1",
    userId: "user-1",
    status: "PENDING",
    assetNetworkId: "an-1",
    walletAddressId: "wa-1",
    txHash: "HASH1",
    eventIndex: 0,
    walletAddress: { address: "rAddr1", destinationTag: "123" },
  };

  const network = { assetSymbol: "XRP" };

  beforeEach(() => {
    prisma = { deposit: { findUniqueOrThrow: jest.fn().mockResolvedValue(depositRow) } };
    adapterFactory = { resolve: jest.fn().mockResolvedValue({ adapter: { inspectTransaction: jest.fn() }, network }) };
    confirmationPolicy = { getRequiredConfirmations: jest.fn().mockResolvedValue(1) };
    depositsService = {
      touchLastChecked: jest.fn().mockResolvedValue(undefined),
      rejectIfNotCredited: jest.fn().mockResolvedValue({ deposit: { ...depositRow, status: "REJECTED" }, justRejected: true }),
      recordObservedTransaction: jest.fn().mockResolvedValue({ status: "CREDITED", confirmations: 5 }),
    };
    auditLog = { record: jest.fn() };

    service = new DepositReprocessingService(
      prisma as never,
      adapterFactory as never,
      confirmationPolicy as never,
      depositsService as never,
      auditLog as never,
    );
  });

  it("re-derives everything from a live adapter lookup and credits through the normal path", async () => {
    const { adapter } = await adapterFactory.resolve();
    (adapter.inspectTransaction as jest.Mock).mockResolvedValue({
      txHash: "HASH1",
      eventIndex: 0,
      amount: "5",
      confirmations: 5,
      destinationTag: "123",
      rawProviderPayload: {},
    });

    const result = await service.reprocess("dep-1", "admin-1");

    expect(depositsService.touchLastChecked).toHaveBeenCalledWith("dep-1");
    expect(depositsService.recordObservedTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", assetSymbol: "XRP", amount: "5", confirmations: 5, requiredConfirmations: 1 }),
    );
    expect(result.status).toBe("CREDITED");
    expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: "deposit.reprocess" }));
  });

  it("marks the deposit REJECTED when the adapter can no longer find the transaction on chain", async () => {
    const resolved = await adapterFactory.resolve();
    (resolved.adapter.inspectTransaction as jest.Mock).mockResolvedValue(null);

    const result = await service.reprocess("dep-1", "admin-1");

    expect(depositsService.rejectIfNotCredited).toHaveBeenCalledWith("dep-1", expect.stringContaining("no longer found"));
    expect(depositsService.recordObservedTransaction).not.toHaveBeenCalled();
    expect(result.status).toBe("REJECTED");
    expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: "deposit.reprocess.rejected" }));
  });

  it("never accepts an admin-supplied amount or confirmation count — only what the live adapter reports", async () => {
    // The method signature itself is the guarantee here: reprocess() takes
    // only (depositId, adminId) — there is no parameter through which an
    // admin could inject an amount, confirmations, or status.
    expect(service.reprocess.length).toBe(2);
  });
});
