import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ComplianceProviderConfigService } from "./compliance-provider-config.service";

describe("ComplianceProviderConfigService", () => {
  let prisma: {
    complianceProviderConfig: { create: jest.Mock; update: jest.Mock; findUnique: jest.Mock; findMany: jest.Mock };
  };
  let service: ComplianceProviderConfigService;

  beforeEach(() => {
    prisma = {
      complianceProviderConfig: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    };
    service = new ComplianceProviderConfigService(prisma as unknown as PrismaService);
  });

  it("rejects a raw-looking credentialsSecretRef", async () => {
    await expect(
      service.createComplianceProviderConfig({ category: "KYC", providerName: "Sumsub", environment: "PRODUCTION", credentialsSecretRef: "raw-api-key-123" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("always creates a config starting disabled", async () => {
    prisma.complianceProviderConfig.create.mockResolvedValue({ id: "cfg-1" });
    await service.createComplianceProviderConfig({ category: "SANCTIONS_KYT", providerName: "Chainalysis", environment: "PRODUCTION" });
    expect(prisma.complianceProviderConfig.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isEnabled: false }) }));
  });

  it("throws NotFoundException enabling/disabling an unknown config", async () => {
    prisma.complianceProviderConfig.findUnique.mockResolvedValue(null);
    await expect(service.setComplianceProviderEnabled("missing", true)).rejects.toThrow(NotFoundException);
  });

  it("rejects a non-https apiBaseUrl (SSRF defense-in-depth)", async () => {
    await expect(
      service.createComplianceProviderConfig({ category: "SANCTIONS_KYT", providerName: "Elliptic", environment: "SANDBOX", apiBaseUrl: "http://aml-api.elliptic.co/v2" }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects setting only one of the two risk-score thresholds", async () => {
    await expect(
      service.createComplianceProviderConfig({ category: "SANCTIONS_KYT", providerName: "Elliptic", environment: "SANDBOX", riskScoreMediumThreshold: 0.3 }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects a medium threshold that is not strictly less than the high threshold", async () => {
    await expect(
      service.createComplianceProviderConfig({
        category: "SANCTIONS_KYT",
        providerName: "Elliptic",
        environment: "SANDBOX",
        riskScoreMediumThreshold: 0.7,
        riskScoreHighThreshold: 0.7,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it("lists configs filtered by category and environment", async () => {
    prisma.complianceProviderConfig.findMany.mockResolvedValue([]);
    await service.listComplianceProviderConfigs({ category: "KYC", environment: "PRODUCTION" });
    expect(prisma.complianceProviderConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { category: "KYC", environment: "PRODUCTION" } }),
    );
  });
});
