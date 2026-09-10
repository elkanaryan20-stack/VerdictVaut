import { assertDatabaseTlsConfigured } from "./database-tls.validator";

const PLAINTEXT_URL = "postgresql://user:pass@db.example.com:5432/app";
const REQUIRE_TLS_URL = "postgresql://user:pass@db.example.com:5432/app?sslmode=require";
const VERIFY_FULL_URL = "postgresql://user:pass@db.example.com:5432/app?sslmode=verify-full";
const PREFER_URL = "postgresql://user:pass@db.example.com:5432/app?sslmode=prefer";
const DISABLE_URL = "postgresql://user:pass@db.example.com:5432/app?sslmode=disable";

describe("assertDatabaseTlsConfigured", () => {
  describe("production", () => {
    it("throws when DATABASE_URL has no sslmode at all", () => {
      expect(() => assertDatabaseTlsConfigured(PLAINTEXT_URL, "production")).toThrow(/sslmode/);
    });

    it("throws when sslmode=disable", () => {
      expect(() => assertDatabaseTlsConfigured(DISABLE_URL, "production")).toThrow(/sslmode/);
    });

    it("throws when sslmode=prefer — a fallback-to-plaintext mode is not a real guarantee", () => {
      expect(() => assertDatabaseTlsConfigured(PREFER_URL, "production")).toThrow(/sslmode/);
    });

    it("accepts sslmode=require", () => {
      expect(() => assertDatabaseTlsConfigured(REQUIRE_TLS_URL, "production")).not.toThrow();
    });

    it("accepts sslmode=verify-full", () => {
      expect(() => assertDatabaseTlsConfigured(VERIFY_FULL_URL, "production")).not.toThrow();
    });

    it("throws a clear error rather than crashing on a malformed URL", () => {
      expect(() => assertDatabaseTlsConfigured("not-a-url", "production")).toThrow(/valid URL/);
    });
  });

  describe("non-production", () => {
    it("never throws for sandbox, regardless of TLS configuration", () => {
      expect(() => assertDatabaseTlsConfigured(PLAINTEXT_URL, "sandbox")).not.toThrow();
    });

    it("does not even attempt to parse the URL outside production", () => {
      expect(() => assertDatabaseTlsConfigured("not-a-url-at-all", "sandbox")).not.toThrow();
    });
  });
});
