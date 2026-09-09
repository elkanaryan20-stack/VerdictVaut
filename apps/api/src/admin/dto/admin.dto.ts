import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from "class-validator";

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

export class StartIndependentRescanDto {
  // Explicit rescan window start, chain-adapter-specific format (e.g. an
  // EVM block number as a string). Omit to use the chain adapter's own
  // bounded "first scan" default backfill — never an unbounded rescan
  // either way, see IndependentReconciliationService's own docblock.
  @IsOptional()
  @IsString()
  fromPointer?: string;
}

export class ResolveDiscrepancyDto {
  @IsString()
  @MinLength(3)
  notes!: string;

  @IsOptional()
  @IsIn(["RESOLVED", "FALSE_POSITIVE"])
  outcome?: "RESOLVED" | "FALSE_POSITIVE";
}
