import { IsString, Matches, MaxLength, MinLength } from "class-validator";

/** Phase 39 — POST /markets/categories (SUPER_ADMIN). */
export class CreateMarketCategoryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, { message: "slug must be lowercase letters, digits and single hyphens" })
  slug!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;
}
