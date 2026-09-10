import { NetworkEnvironment } from "@prisma/client";
import { assertProviderConfigEnvironmentMatches, requiredProviderConfigEnvironment } from "./provider-environment.util";

describe("requiredProviderConfigEnvironment", () => {
  it("requires PRODUCTION only for the literal string 'production'", () => {
    expect(requiredProviderConfigEnvironment("production")).toBe(NetworkEnvironment.PRODUCTION);
  });

  it("requires SANDBOX for 'sandbox'", () => {
    expect(requiredProviderConfigEnvironment("sandbox")).toBe(NetworkEnvironment.SANDBOX);
  });

  it("requires SANDBOX for 'staging' (not a recognized AppConfig value, but must still fail closed to the more restrictive requirement)", () => {
    expect(requiredProviderConfigEnvironment("staging")).toBe(NetworkEnvironment.SANDBOX);
  });

  it("requires SANDBOX for any other/unrecognized value — never defaults to PRODUCTION", () => {
    expect(requiredProviderConfigEnvironment("")).toBe(NetworkEnvironment.SANDBOX);
    expect(requiredProviderConfigEnvironment("PRODUCTION")).toBe(NetworkEnvironment.SANDBOX); // case-sensitive: only the exact literal "production" counts
    expect(requiredProviderConfigEnvironment("prod")).toBe(NetworkEnvironment.SANDBOX);
  });
});

describe("assertProviderConfigEnvironmentMatches", () => {
  it("does not throw when the provider config environment matches what's required", () => {
    expect(() => assertProviderConfigEnvironmentMatches(NetworkEnvironment.SANDBOX, "sandbox", "test config")).not.toThrow();
    expect(() => assertProviderConfigEnvironmentMatches(NetworkEnvironment.PRODUCTION, "production", "test config")).not.toThrow();
  });

  it("throws when a SANDBOX appEnvironment is given a PRODUCTION provider config", () => {
    expect(() => assertProviderConfigEnvironmentMatches(NetworkEnvironment.PRODUCTION, "sandbox", "test config")).toThrow(/flagged PRODUCTION/);
  });

  it("throws when a 'staging' appEnvironment is given a PRODUCTION provider config", () => {
    expect(() => assertProviderConfigEnvironmentMatches(NetworkEnvironment.PRODUCTION, "staging", "test config")).toThrow(/flagged PRODUCTION/);
  });

  it("throws when a PRODUCTION appEnvironment is given a SANDBOX provider config", () => {
    expect(() => assertProviderConfigEnvironmentMatches(NetworkEnvironment.SANDBOX, "production", "test config")).toThrow(/flagged SANDBOX/);
  });

  it("includes the caller-provided description in the error, for an actionable message", () => {
    expect(() => assertProviderConfigEnvironmentMatches(NetworkEnvironment.PRODUCTION, "sandbox", "CustodyProviderConfig cfg-123")).toThrow(/CustodyProviderConfig cfg-123/);
  });
});
