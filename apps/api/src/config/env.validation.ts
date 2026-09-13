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

  // Phase 20 — "none" (the default) makes no real email send anywhere,
  // including every test run. Selecting "postmark" without the three
  // fields below is a real, checked configuration error, not silently
  // tolerated — see the production-only blocker further down for the
  // hardest form of that check.
  @IsIn(["none", "postmark"])
  @IsOptional()
  EMAIL_PROVIDER: string = "none";

  @IsString()
  @IsOptional()
  POSTMARK_SERVER_TOKEN: string = "";

  @IsString()
  @IsOptional()
  EMAIL_FROM_ADDRESS: string = "";

  // Deliberately just @IsString() here, not @IsUrl() — class-validator's
  // @IsOptional() only exempts null/undefined, not this field's own ""
  // default, so an @IsUrl() decorator would fail validation in every
  // environment that leaves this unset (i.e. almost every dev/test run
  // today). Real URL-shape checking happens once, in
  // assertProductionEmailConfigured below, exactly when a value is
  // actually required. This is never fetched by the server itself (it
  // only ever appears inside an email body as a link a human clicks),
  // so it carries no SSRF risk; the only real risk is an open-redirect/
  // phishing-style link if this were ever attacker-influenced, which it
  // cannot be — it is a fixed operator-set env var, never derived from
  // request input (see docs/email-delivery.md's security section).
  @IsString()
  @IsOptional()
  EMAIL_BASE_URL: string = "";
}

/**
 * Phase 20 — belt-and-suspenders alongside PostmarkEmailProvider's own
 * runtime behavior: production must never silently fall back to
 * NoopEmailProvider just because required config is missing. Kept as a
 * small standalone function (not inlined into validateEnv's blockers
 * array) so it has its own name and can be unit-tested directly, the
 * same reasoning assertDatabaseTlsConfigured already gets its own file.
 */
export function assertProductionEmailConfigured(env: { EMAIL_PROVIDER: string; POSTMARK_SERVER_TOKEN: string; EMAIL_FROM_ADDRESS: string; EMAIL_BASE_URL: string }): void {
  if (env.EMAIL_PROVIDER !== "postmark") {
    throw new Error(
      "production requires EMAIL_PROVIDER=postmark — the default 'none' selects NoopEmailProvider, which sends no real email and must never be used in production.",
    );
  }
  if (!env.POSTMARK_SERVER_TOKEN) {
    throw new Error("production requires POSTMARK_SERVER_TOKEN to be set when EMAIL_PROVIDER=postmark.");
  }
  if (!env.EMAIL_FROM_ADDRESS) {
    throw new Error("production requires EMAIL_FROM_ADDRESS to be set when EMAIL_PROVIDER=postmark.");
  }
  if (!env.EMAIL_BASE_URL) {
    throw new Error("production requires EMAIL_BASE_URL to be set when EMAIL_PROVIDER=postmark (used to construct the verification link).");
  }
  try {
    // eslint-disable-next-line no-new
    new URL(env.EMAIL_BASE_URL);
  } catch {
    throw new Error(`production requires EMAIL_BASE_URL to be a valid URL — got "${env.EMAIL_BASE_URL}".`);
  }
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

    try {
      assertProductionEmailConfigured(validated);
    } catch (error) {
      blockers.push((error as Error).message);
    }

    throw new Error(`APP_ENVIRONMENT=production is not supported yet:\n${blockers.map((b) => `  - ${b}`).join("\n")}`);
  }

  return validated;
}
