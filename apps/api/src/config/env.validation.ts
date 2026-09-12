import { plainToInstance } from "class-transformer";
import { IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength, validateSync } from "class-validator";
import { assertDatabaseTlsConfigured } from "./database-tls.validator";

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
  @MinLength(32, { message: "JWT_ACCESS_SECRET must be at least 32 characters" })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32, { message: "JWT_REFRESH_SECRET must be at least 32 characters" })
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_ACCESS_TTL: string = "15m";

  @IsString()
  @IsOptional()
  JWT_REFRESH_TTL: string = "7d";

  @IsOptional()
  ENABLE_DEV_FUNDING_TOOLS: string = "false";

  @IsString()
  @IsOptional()
  CORS_ALLOWED_ORIGINS: string = "";

  @IsOptional()
  CHAIN_WATCHER_ENABLED: string = "false";

  @IsInt()
  @IsOptional()
  CHAIN_WATCHER_POLL_INTERVAL_MS: number = 30000;

  @IsOptional()
  WITHDRAWAL_WATCHER_ENABLED: string = "false";

  @IsInt()
  @IsOptional()
  WITHDRAWAL_WATCHER_POLL_INTERVAL_MS: number = 30000;

  @IsOptional()
  ALLOW_WATCHERS_IN_API_PROCESS: string = "false";

  @IsString()
  @IsOptional()
  WORKER_HEARTBEAT_FILE: string = "/tmp/verdictvaut-worker-heartbeat";

  @IsInt()
  @IsOptional()
  WORKER_HEARTBEAT_INTERVAL_MS: number = 15000;
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
    // Every independent production-safety condition is checked and
    // collected here, rather than stopping at the first failure — so
    // fixing the TLS blocker below, for instance, never silently
    // "reveals" a false green light while custody is still unimplemented,
    // and an operator sees the FULL list of what's still blocking
    // production in one pass instead of playing whack-a-mole.
    const blockers: string[] = [
      "production custody is not implemented yet — ProductionCustodyExecutor is an intentional fail-closed " +
        "placeholder until a real provider is selected and integrated (use APP_ENVIRONMENT=sandbox)",
    ];

    try {
      assertDatabaseTlsConfigured(validated.DATABASE_URL, validated.APP_ENVIRONMENT);
    } catch (error) {
      blockers.push((error as Error).message);
    }

    throw new Error(`APP_ENVIRONMENT=production is not supported yet:\n${blockers.map((b) => `  - ${b}`).join("\n")}`);
  }

  return validated;
}
