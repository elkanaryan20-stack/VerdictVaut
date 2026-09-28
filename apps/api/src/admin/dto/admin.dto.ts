import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, Matches, Min, MinLength, ValidateIf } from "class-validator";

const DECIMAL_STRING = /^\d+(\.\d+)?$/;

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

  // Phase 40 — this property had NO validation decorator, so the global
  // ValidationPipe (whitelist + forbidNonWhitelisted) rejected it as
  // "should not exist" on every request — while the service requires it.
  // POST /admin/asset-networks was therefore unusable, leaving a fresh
  // production deployment (whose seed-free database has no mainnet
  // asset/networks) with no API path to enable any asset at all.
  @IsInt()
  @Min(1)
  minConfirmations!: number;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_STRING, { message: "depositMinAmount must be a non-negative decimal string" })
  depositMinAmount?: string;

  @IsOptional()
  @IsString()
  @Matches(DECIMAL_STRING, { message: "withdrawalMinAmount must be a non-negative decimal string" })
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

// Phase 35 — R1 recovery entry point. Only a reason is accepted: the
// evidence rules (which states qualify, the live chain lookup for a
// broadcast one) are enforced server-side, never supplied by the caller.
export class DeclareExecutionAmbiguousDto {
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

// Phase 14A — resolving an EXECUTION_AMBIGUOUS withdrawal. txHash is
// required for CONFIRMED_BROADCAST specifically (the real transaction
// hash the admin actually found — never fabricated) and forbidden
// otherwise, so a caller can't accidentally attach an unused/stale
// value to a CONFIRMED_NOT_EXECUTED resolution.
export class ResolveAmbiguousExecutionDto {
  @IsIn(["CONFIRMED_BROADCAST", "CONFIRMED_NOT_EXECUTED"])
  outcome!: "CONFIRMED_BROADCAST" | "CONFIRMED_NOT_EXECUTED";

  @ValidateIf((dto: ResolveAmbiguousExecutionDto) => dto.outcome === "CONFIRMED_BROADCAST")
  @IsString()
  @MinLength(4)
  txHash?: string;

  @IsString()
  @MinLength(3)
  notes!: string;
}

// Phase 14A — provider-neutral custody configuration. providerName is
// free-text/display data only, never branched on by application code
// (see CustodyProviderConfig's own schema docblock). credentialsSecretRef/
// webhookSecretRef are validated as "scheme:path" references, never raw
// secrets — see CustodyProviderConfigService/secret-ref.validator.
export class CreateCustodyProviderConfigDto {
  @IsString()
  @MinLength(1)
  providerName!: string;

  @IsIn(["SANDBOX", "PRODUCTION"])
  environment!: "SANDBOX" | "PRODUCTION";

  @IsOptional()
  @IsString()
  credentialsSecretRef?: string;

  @IsOptional()
  @IsString()
  webhookUrl?: string;

  @IsOptional()
  @IsString()
  webhookSecretRef?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  timeoutMs?: number;

  @IsOptional()
  @IsString()
  idempotencyHeaderName?: string;

  @IsOptional()
  @IsString()
  vaultOrAccountRef?: string;

  // Phase 14B — non-secret REST base URL (e.g.
  // "https://sandbox-api.fireblocks.io/v1"), verified against the
  // provider's own docs. Never a place for credentials.
  @IsOptional()
  @IsString()
  apiBaseUrl?: string;
}

export class SetWithdrawalExecutionConfigDto {
  @IsString()
  assetNetworkId!: string;

  @IsIn(["SANDBOX", "PRODUCTION"])
  environment!: "SANDBOX" | "PRODUCTION";

  @IsIn(["MANUAL_BROADCAST", "PRODUCTION_CUSTODY"])
  executorType!: "MANUAL_BROADCAST" | "PRODUCTION_CUSTODY";

  @ValidateIf((dto: SetWithdrawalExecutionConfigDto) => dto.executorType === "PRODUCTION_CUSTODY")
  @IsString()
  custodyProviderConfigId?: string;

  @IsOptional()
  @IsString()
  providerRef?: string;

  // Phase 14B — the provider's OWN asset identifier (e.g. a Fireblocks
  // assetId string), never inferred/guessed by application code. An
  // admin must explicitly verify this against the real provider account
  // before setting it — see WithdrawalExecutionConfig.providerAssetId's
  // own schema docblock.
  @IsOptional()
  @IsString()
  providerAssetId?: string;
}

// Phase 14A — provider-neutral compliance configuration. See
// ComplianceProviderConfig's own schema docblock: configuring (even
// enabling) a row here does NOT itself make WithdrawalComplianceGate
// real, and is never itself a legal-compliance claim.
export class CreateComplianceProviderConfigDto {
  @IsIn(["KYC", "SANCTIONS_KYT"])
  category!: "KYC" | "SANCTIONS_KYT";

  @IsString()
  @MinLength(1)
  providerName!: string;

  @IsIn(["SANDBOX", "PRODUCTION"])
  environment!: "SANDBOX" | "PRODUCTION";

  @IsOptional()
  @IsString()
  credentialsSecretRef?: string;

  @IsOptional()
  @IsString()
  webhookUrl?: string;

  @IsOptional()
  @IsString()
  webhookSecretRef?: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  timeoutMs?: number;

  // Phase 14B — non-secret REST base URL (e.g.
  // "https://aml-api.elliptic.co/v2"), verified against the provider's
  // own docs.
  @IsOptional()
  @IsString()
  apiBaseUrl?: string;

  // Phase 14B — admin-configured thresholds for mapping a raw numeric
  // provider risk score (e.g. Elliptic's risk_score) onto
  // AddressRiskStatus. Both must be set before scores from this
  // provider can be categorized at all — see
  // elliptic-risk.mapper.ts/EllipticAddressRiskGate.
  @IsOptional()
  @IsNumber()
  riskScoreMediumThreshold?: number;

  @IsOptional()
  @IsNumber()
  riskScoreHighThreshold?: number;
}
