import { IsOptional, IsString, Matches, MinLength } from "class-validator";

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
}
