import { InternalServerErrorException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ManualBroadcastExecutor } from "./manual-broadcast.executor";
import { ProductionCustodyExecutor } from "./production-custody.executor";
import { WithdrawalExecutorFactory } from "./withdrawal-executor.factory";

describe("WithdrawalExecutorFactory", () => {
  let prisma: { withdrawalExecutionConfig: { findUnique: jest.Mock } };
  let config: { get: jest.Mock };
  let manual: ManualBroadcastExecutor;
  let production: ProductionCustodyExecutor;
  let factory: WithdrawalExecutorFactory;

  beforeEach(() => {
    prisma = { withdrawalExecutionConfig: { findUnique: jest.fn() } };
    config = { get: jest.fn().mockReturnValue("sandbox") };
    manual = new ManualBroadcastExecutor();
    production = new ProductionCustodyExecutor();
    factory = new WithdrawalExecutorFactory(prisma as unknown as PrismaService, config as never, manual, production);
  });

  it("defaults to ManualBroadcastExecutor in sandbox when no config row exists", async () => {
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue(null);
    expect(await factory.resolve("an-1")).toBe(manual);
  });

  it("uses ProductionCustodyExecutor in sandbox when explicitly configured", async () => {
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({ executorType: "PRODUCTION_CUSTODY" });
    expect(await factory.resolve("an-1")).toBe(production);
  });

  it("refuses to fall back to manual broadcast in production when no PRODUCTION_CUSTODY config exists", async () => {
    config.get.mockReturnValue("production");
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue(null);

    await expect(factory.resolve("an-1")).rejects.toThrow(InternalServerErrorException);
  });

  it("refuses to fall back to manual broadcast in production even if a MANUAL_BROADCAST config row exists", async () => {
    config.get.mockReturnValue("production");
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({ executorType: "MANUAL_BROADCAST" });

    await expect(factory.resolve("an-1")).rejects.toThrow(InternalServerErrorException);
  });

  it("uses ProductionCustodyExecutor in production when explicitly configured", async () => {
    config.get.mockReturnValue("production");
    prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({ executorType: "PRODUCTION_CUSTODY" });

    expect(await factory.resolve("an-1")).toBe(production);
  });
});
