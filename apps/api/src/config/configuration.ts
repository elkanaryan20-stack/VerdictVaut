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
});
