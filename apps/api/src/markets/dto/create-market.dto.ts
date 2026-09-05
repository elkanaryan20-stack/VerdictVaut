import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsISO8601, IsOptional, IsString, MinLength, ValidateNested } from "class-validator";

export class MarketOutcomeInputDto {
  @IsString()
  @MinLength(1)
  key!: string;

  @IsString()
  @MinLength(1)
  label!: string;
}

export class CreateMarketDto {
  @IsString()
  @MinLength(3)
  slug!: string;

  @IsString()
  @MinLength(3)
  title!: string;

  @IsString()
  description!: string;

  @IsString()
  categorySlug!: string;

  @IsOptional()
  @IsString()
  resolutionSource?: string;

  @IsOptional()
  @IsString()
  resolutionCriteria?: string;

  @IsOptional()
  @IsISO8601()
  openTime?: string;

  @IsOptional()
  @IsISO8601()
  closeTime?: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => MarketOutcomeInputDto)
  outcomes!: MarketOutcomeInputDto[];
}
