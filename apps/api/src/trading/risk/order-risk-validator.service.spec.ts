import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { OrderRiskValidator } from "./order-risk-validator.service";

describe("OrderRiskValidator", () => {
  let validator: OrderRiskValidator;
  let prisma: {
    riskLimit: { findUnique: jest.Mock };
    position: { findUnique: jest.Mock };
    market: { findUniqueOrThrow: jest.Mock };
    order: { findMany: jest.Mock };
  };

  const baseInput = {
    userId: "user-1",
    marketId: "market-1",
    outcomeId: "outcome-1",
    side: "BUY" as const,
    price: new Prisma.Decimal("0.5"),
    quantity: new Prisma.Decimal("10"),
  };

  beforeEach(() => {
    prisma = {
      riskLimit: { findUnique: jest.fn().mockResolvedValue(null) },
      position: { findUnique: jest.fn().mockResolvedValue(null) },
      market: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "market-1", maxExposure: null }) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
    };
    validator = new OrderRiskValidator(prisma as unknown as PrismaService);
  });

  it("passes when no RiskLimit row exists (unlimited by default)", async () => {
    await expect(validator.validate(baseInput, prisma as never)).resolves.toBeUndefined();
  });

  it("rejects a quantity above maxOrderQuantity", async () => {
    prisma.riskLimit.findUnique.mockResolvedValue({ maxOrderQuantity: new Prisma.Decimal("5") });
    await expect(validator.validate(baseInput, prisma as never)).rejects.toThrow(BadRequestException);
  });

  it("allows a quantity at exactly maxOrderQuantity", async () => {
    prisma.riskLimit.findUnique.mockResolvedValue({ maxOrderQuantity: new Prisma.Decimal("10") });
    await expect(validator.validate(baseInput, prisma as never)).resolves.toBeUndefined();
  });

  it("rejects a notional above maxOrderNotional", async () => {
    prisma.riskLimit.findUnique.mockResolvedValue({ maxOrderNotional: new Prisma.Decimal("4") }); // 10*0.5=5 > 4
    await expect(validator.validate(baseInput, prisma as never)).rejects.toThrow(BadRequestException);
  });

  it("rejects a BUY that would push the resulting position above maxPositionSize", async () => {
    prisma.riskLimit.findUnique.mockResolvedValue({ maxPositionSize: new Prisma.Decimal("15") });
    prisma.position.findUnique.mockResolvedValue({ quantity: new Prisma.Decimal("10") }); // 10+10=20 > 15
    await expect(validator.validate(baseInput, prisma as never)).rejects.toThrow(BadRequestException);
  });

  it("allows a BUY within maxPositionSize when accounting for existing holdings", async () => {
    prisma.riskLimit.findUnique.mockResolvedValue({ maxPositionSize: new Prisma.Decimal("25") });
    prisma.position.findUnique.mockResolvedValue({ quantity: new Prisma.Decimal("10") }); // 10+10=20 <= 25
    await expect(validator.validate(baseInput, prisma as never)).resolves.toBeUndefined();
  });

  it("does not apply maxPositionSize to SELL orders", async () => {
    prisma.riskLimit.findUnique.mockResolvedValue({ maxPositionSize: new Prisma.Decimal("1") });
    await expect(validator.validate({ ...baseInput, side: "SELL" }, prisma as never)).resolves.toBeUndefined();
    expect(prisma.position.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a BUY that would push market exposure above the configured cap", async () => {
    prisma.market.findUniqueOrThrow.mockResolvedValue({ id: "market-1", maxExposure: new Prisma.Decimal("10") });
    prisma.order.findMany.mockResolvedValue([
      { remainingQuantity: new Prisma.Decimal("10"), price: new Prisma.Decimal("0.5") }, // existing exposure = 5
    ]);
    // existing 5 + this order's 10*0.5=5 => 10, still within cap; bump quantity to exceed
    await expect(
      validator.validate({ ...baseInput, quantity: new Prisma.Decimal("20") }, prisma as never),
    ).rejects.toThrow(BadRequestException);
  });

  it("allows an order that keeps market exposure within the cap", async () => {
    prisma.market.findUniqueOrThrow.mockResolvedValue({ id: "market-1", maxExposure: new Prisma.Decimal("100") });
    await expect(validator.validate(baseInput, prisma as never)).resolves.toBeUndefined();
  });

  it("skips the market-exposure check entirely when no cap is configured", async () => {
    prisma.market.findUniqueOrThrow.mockResolvedValue({ id: "market-1", maxExposure: null });
    await validator.validate(baseInput, prisma as never);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });
});
