import { IsArray, IsISO8601, IsOptional, IsString, MinLength } from "class-validator";

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
  @IsISO8601()
  closeTime?: string;

  @IsOptional()
  @IsString()
  resolutionSource?: string;

  @IsArray()
  @IsString({ each: true })
  outcomeLabels!: string[];
}
