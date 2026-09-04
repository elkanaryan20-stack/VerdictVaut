import { IsBoolean, IsOptional, IsString, MinLength } from "class-validator";

export class CreateAssetNetworkDto {
  @IsString()
  assetSymbol!: string;

  @IsString()
  networkCode!: string;

  @IsBoolean()
  isNative!: boolean;

  @IsOptional()
  @IsString()
  contractAddress?: string;

  @IsOptional()
  @IsBoolean()
  memoRequired?: boolean;

  minConfirmations!: number;

  @IsOptional()
  depositMinAmount?: string;

  @IsOptional()
  withdrawalMinAmount?: string;
}

export class SetActiveDto {
  @IsBoolean()
  isActive!: boolean;
}

export class ProvisionAddressDto {
  @IsString()
  assetNetworkId!: string;

  @IsString()
  @MinLength(4)
  address!: string;

  @IsOptional()
  @IsString()
  destinationTag?: string;

  @IsString()
  environment!: "SANDBOX" | "PRODUCTION";
}

export class RejectWithdrawalDto {
  @IsString()
  @MinLength(3)
  reason!: string;
}
