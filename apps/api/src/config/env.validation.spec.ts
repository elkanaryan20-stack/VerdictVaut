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

  it("Phase 37: refuses identical access and refresh secrets (a refresh token would otherwise pass as an access token)", () => {
    const same = "s".repeat(40);
    expect(() => validateEnv(baseConfig({ JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same }))).toThrow(/must differ/);
  });

  it("Phase 37: TRUST_PROXY_HOPS defaults to 0 and rejects a negative value", () => {
    expect(validateEnv(baseConfig()).TRUST_PROXY_HOPS).toBe(0);
    expect(() => validateEnv(baseConfig({ TRUST_PROXY_HOPS: "-1" }))).toThrow(/TRUST_PROXY_HOPS/);
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

    describe("email (Phase 20)", () => {
      it("reports the email blocker when EMAIL_PROVIDER is left at its 'none' default", () => {
        expect(() =>
          validateEnv(
            baseConfig({
              APP_ENVIRONMENT: "production",
              DATABASE_URL: "postgresql://user:pass@prod-db.example.com:5432/app?sslmode=require",
            }),
          ),
        ).toThrow(/EMAIL_PROVIDER=postmark/);
      });

      it("reports the email blocker when EMAIL_PROVIDER=postmark but POSTMARK_SERVER_TOKEN is missing", () => {
        expect(() =>
          validateEnv(
            baseConfig({
              APP_ENVIRONMENT: "production",
              DATABASE_URL: "postgresql://user:pass@prod-db.example.com:5432/app?sslmode=require",
              EMAIL_PROVIDER: "postmark",
              EMAIL_FROM_ADDRESS: "noreply@verdictvaut.example",
              EMAIL_BASE_URL: "https://app.verdictvaut.example",
            }),
          ),
        ).toThrow(/POSTMARK_SERVER_TOKEN/);
      });

      it("reports the email blocker when EMAIL_BASE_URL is not a valid URL", () => {
        expect(() =>
          validateEnv(
            baseConfig({
              APP_ENVIRONMENT: "production",
              DATABASE_URL: "postgresql://user:pass@prod-db.example.com:5432/app?sslmode=require",
              EMAIL_PROVIDER: "postmark",
              POSTMARK_SERVER_TOKEN: "real-server-token",
              EMAIL_FROM_ADDRESS: "noreply@verdictvaut.example",
              EMAIL_BASE_URL: "not-a-url",
            }),
          ),
        ).toThrow(/EMAIL_BASE_URL to be a valid URL/);
      });

      it("does NOT report the email blocker when EMAIL_PROVIDER=postmark with all required fields present — only the (still-unresolved) custody blocker remains", () => {
        let thrown: Error | undefined;
        try {
          validateEnv(
            baseConfig({
              APP_ENVIRONMENT: "production",
              DATABASE_URL: "postgresql://user:pass@prod-db.example.com:5432/app?sslmode=verify-full",
              EMAIL_PROVIDER: "postmark",
              POSTMARK_SERVER_TOKEN: "real-server-token",
              EMAIL_FROM_ADDRESS: "noreply@verdictvaut.example",
              EMAIL_BASE_URL: "https://app.verdictvaut.example",
            }),
          );
        } catch (error) {
          thrown = error as Error;
        }
        expect(thrown).toBeDefined();
        expect(thrown!.message).toMatch(/production custody is not implemented/);
        expect(thrown!.message).not.toMatch(/EMAIL_PROVIDER=postmark/);
        expect(thrown!.message).not.toMatch(/POSTMARK_SERVER_TOKEN/);
      });
    });
  });
});
