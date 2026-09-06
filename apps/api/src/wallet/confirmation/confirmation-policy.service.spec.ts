import { ConfirmationPolicyService } from "./confirmation-policy.service";

describe("ConfirmationPolicyService", () => {
  let prisma: { assetNetwork: { findUniqueOrThrow: jest.Mock } };
  let service: ConfirmationPolicyService;

  beforeEach(() => {
    prisma = { assetNetwork: { findUniqueOrThrow: jest.fn().mockResolvedValue({ minConfirmations: 12 }) } };
    service = new ConfirmationPolicyService(prisma as never);
  });

  it("reads the required confirmations from the asset/network configuration", async () => {
    await expect(service.getRequiredConfirmations("an-1")).resolves.toBe(12);
    expect(prisma.assetNetwork.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "an-1" } });
  });

  describe("isFinal", () => {
    it("is final when confirmations meet the requirement", () => {
      expect(service.isFinal(12, 12)).toBe(true);
    });

    it("is final when confirmations exceed the requirement", () => {
      expect(service.isFinal(20, 12)).toBe(true);
    });

    it("is not final when confirmations fall short", () => {
      expect(service.isFinal(11, 12)).toBe(false);
    });

    it("never treats a negative confirmation count as final", () => {
      expect(service.isFinal(-1, 0)).toBe(false);
    });
  });
});
