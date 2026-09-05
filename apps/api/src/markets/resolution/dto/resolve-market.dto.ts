import { IsOptional, IsString, MinLength } from "class-validator";

export class ResolveMarketDto {
  @IsString()
  @MinLength(1)
  winningOutcomeId!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
