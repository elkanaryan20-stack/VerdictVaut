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
  // Same off-by-default reasoning as chainWatcher — polls
  // BROADCAST/CONFIRMING withdrawals via CustodyProvider's read-only
  // chain queries and calls WithdrawalsService.recordConfirmation() with
  // real observed data (see WithdrawalWatcherService).
  withdrawalWatcher: {
    enabled: boolean;
    pollIntervalMs: number;
  };
  // Phase 16 — the HTTP API process (main.ts) refuses to boot at all if
  // either watcher above is enabled unless this is explicitly true (see
  // config/watcher-boundary.guard.ts). Background watchers belong in the
  // dedicated worker process (worker.main.ts); this exists only as an
  // explicit escape hatch for a deliberate single-process deployment
  // (e.g. a small self-hosted install), never a silent default.
  allowWatchersInApiProcess: boolean;
  worker: {
    heartbeatFile: string;
    heartbeatIntervalMs: number;
  };
  // Phase 20 — account-verification email delivery. "none" (the
  // default) selects NoopEmailProvider: no real email is ever sent, and
  // no POSTMARK_SERVER_TOKEN/EMAIL_FROM_ADDRESS/EMAIL_BASE_URL value is
  // required. "postmark" selects the real PostmarkEmailProvider — see
  // email/email-provider.factory.ts. Production additionally requires
  // "postmark" with all three values present (env.validation.ts) — the
  // no-op provider must never be silently selected in production.
  email: {
    provider: "none" | "postmark";
    postmarkServerToken: string;
    fromAddress: string;
    baseUrl: string;
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
  withdrawalWatcher: {
    enabled: process.env.WITHDRAWAL_WATCHER_ENABLED === "true",
    pollIntervalMs: parseInt(process.env.WITHDRAWAL_WATCHER_POLL_INTERVAL_MS ?? "30000", 10),
  },
  allowWatchersInApiProcess: process.env.ALLOW_WATCHERS_IN_API_PROCESS === "true",
  worker: {
    heartbeatFile: process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/verdictvaut-worker-heartbeat",
    heartbeatIntervalMs: parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "15000", 10),
  },
  email: {
    provider: (process.env.EMAIL_PROVIDER as "none" | "postmark") ?? "none",
    postmarkServerToken: process.env.POSTMARK_SERVER_TOKEN ?? "",
    fromAddress: process.env.EMAIL_FROM_ADDRESS ?? "",
    baseUrl: process.env.EMAIL_BASE_URL ?? "",
  },
});
