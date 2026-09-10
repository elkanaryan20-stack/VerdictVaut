import "reflect-metadata"; // required by class-validator/class-transformer decorators — main.ts loads this at real boot, but a standalone unit test must load it itself
import { validateEnv } from "./env.validation";

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    NODE_ENV: "development",
    APP_ENVIRONMENT: "sandbox",
    PORT: "4000",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/app",
    JWT_ACCESS_SECRET: "a".repeat(32),
    JWT_REFRESH_SECRET: "b".repeat(32),
    ...overrides,
  };
}

describe("validateEnv", () => {
  it("accepts a valid sandbox/development configuration", () => {
    expect(() => validateEnv(baseConfig())).not.toThrow();
  });

  it("accepts sandbox even with no DATABASE_URL TLS configured — local Postgres has no TLS listener", () => {
    expect(() => validateEnv(baseConfig({ APP_ENVIRONMENT: "sandbox" }))).not.toThrow();
  });

  it("rejects a JWT secret shorter than 32 characters", () => {
    expect(() => validateEnv(baseConfig({ JWT_ACCESS_SECRET: "too-short" }))).toThrow(/JWT_ACCESS_SECRET/);
  });

  describe("production", () => {
    it("still refuses to boot even with valid DB TLS configured — custody remains a separate, unresolved blocker", () => {
      expect(() =>
        validateEnv(
          baseConfig({
            APP_ENVIRONMENT: "production",
            DATABASE_URL: "postgresql://user:pass@prod-db.example.com:5432/app?sslmode=require",
          }),
        ),
      ).toThrow(/production custody is not implemented/);
    });

    it("reports the DB TLS blocker too when DATABASE_URL has no TLS enforced", () => {
      expect(() =>
        validateEnv(
          baseConfig({
            APP_ENVIRONMENT: "production",
            DATABASE_URL: "postgresql://user:pass@prod-db.example.com:5432/app",
          }),
        ),
      ).toThrow(/sslmode/);
    });

    it("does NOT report the DB TLS blocker when DATABASE_URL already enforces it — only the custody blocker remains", () => {
      let thrown: Error | undefined;
      try {
        validateEnv(
          baseConfig({
            APP_ENVIRONMENT: "production",
            DATABASE_URL: "postgresql://user:pass@prod-db.example.com:5432/app?sslmode=verify-full",
          }),
        );
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown!.message).toMatch(/production custody is not implemented/);
      expect(thrown!.message).not.toMatch(/sslmode/);
    });
  });
});
