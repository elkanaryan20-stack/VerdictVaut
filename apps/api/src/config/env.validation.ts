import { plainToInstance } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min, validateSync } from "class-validator";

class EnvironmentVariables {
  @IsIn(["development", "test", "production"])
  NODE_ENV: string = "development";

  @IsIn(["sandbox", "production"])
  APP_ENVIRONMENT: string = "sandbox";

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 4000;

  @IsString()
  DATABASE_URL!: string;

  @IsString()
  JWT_ACCESS_SECRET!: string;

  @IsString()
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_ACCESS_TTL: string = "15m";

  @IsString()
  @IsOptional()
  JWT_REFRESH_TTL: string = "7d";

  @IsOptional()
  ENABLE_DEV_FUNDING_TOOLS: string = "false";
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${errors
        .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join(", ")}`)
        .join("\n")}`,
    );
  }

  if (validated.APP_ENVIRONMENT === "production") {
    throw new Error(
      "APP_ENVIRONMENT=production is not supported yet — production custody is not implemented. " +
        "Use APP_ENVIRONMENT=sandbox.",
    );
  }

  return validated;
}
