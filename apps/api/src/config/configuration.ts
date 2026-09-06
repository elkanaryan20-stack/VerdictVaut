export interface AppConfig {
  nodeEnv: string;
  appEnvironment: "sandbox" | "production";
  port: number;
  databaseUrl: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
  };
  devFundingToolsEnabled: boolean;
  corsAllowedOrigins: string[];
  chainWatcher: {
    // Off by default: unit/integration tests, and any environment that
    // hasn't deliberately opted in, must never make outbound network
    // calls to a real chain provider just from importing this module.
    enabled: boolean;
    pollIntervalMs: number;
  };
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? "development",
  appEnvironment: (process.env.APP_ENVIRONMENT as "sandbox" | "production") ?? "sandbox",
  port: parseInt(process.env.PORT ?? "4000", 10),
  databaseUrl: process.env.DATABASE_URL ?? "",
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? "",
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? "",
    accessTtl: process.env.JWT_ACCESS_TTL ?? "15m",
    refreshTtl: process.env.JWT_REFRESH_TTL ?? "7d",
  },
  // Belt-and-suspenders: this flag alone never gates the route — dev-only
  // controllers also assert NODE_ENV !== 'production' at call time.
  devFundingToolsEnabled:
    process.env.ENABLE_DEV_FUNDING_TOOLS === "true" && process.env.NODE_ENV !== "production",
  // Empty outside development unless explicitly configured — CORS fails
  // closed by default rather than open.
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  chainWatcher: {
    enabled: process.env.CHAIN_WATCHER_ENABLED === "true",
    pollIntervalMs: parseInt(process.env.CHAIN_WATCHER_POLL_INTERVAL_MS ?? "30000", 10),
  },
});
