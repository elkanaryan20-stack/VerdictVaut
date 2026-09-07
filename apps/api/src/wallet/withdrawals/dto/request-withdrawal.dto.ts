import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class RequestWithdrawalDto {
  @IsString()
  assetSymbol!: string;

  @IsString()
  networkCode!: string;

  @IsString()
  @Matches(/^\d+(\.\d+)?$/, { message: "amount must be a positive decimal string" })
  amount!: string;

  @IsString()
  @MinLength(4)
  destinationAddress!: string;

  @IsOptional()
  @IsString()
  destinationTag?: string;

  /**
   * Idempotency key. Optional — if omitted, the server generates one,
   * meaning that specific call gets no retry-safety, but the column is
   * never null (see Withdrawal.clientWithdrawalId). Supply your own to
   * make retries of this exact submission safe — the same convention as
   * CreateOrderDto.clientOrderId.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  clientWithdrawalId?: string;
}
