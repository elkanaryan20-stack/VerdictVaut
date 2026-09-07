import { Prisma } from "@prisma/client";
import { ZeroWithdrawalFeeCalculator } from "./zero-withdrawal-fee.calculator";

describe("ZeroWithdrawalFeeCalculator", () => {
  it("always returns a zero fee, regardless of asset/network/amount", () => {
    const calculator = new ZeroWithdrawalFeeCalculator();
    const result = calculator.calculateWithdrawalFee({
      assetSymbol: "USDC",
      networkCode: "ethereum-sepolia",
      amount: new Prisma.Decimal("1000000"),
    });
    expect(result.fee.isZero()).toBe(true);
  });
});
