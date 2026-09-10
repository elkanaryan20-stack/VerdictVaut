import { redactSensitiveFields } from "./redact.util";

describe("redactSensitiveFields", () => {
  it("redacts a top-level password field", () => {
    expect(redactSensitiveFields({ email: "a@example.com", password: "hunter2" })).toEqual({
      email: "a@example.com",
      password: "[REDACTED]",
    });
  });

  it("redacts JWTs, secrets, and tokens by key name, case-insensitively", () => {
    const input = { JWT_ACCESS_SECRET: "x", refreshToken: "y", apiKey: "z", authorization: "Bearer abc" };
    expect(redactSensitiveFields(input)).toEqual({
      JWT_ACCESS_SECRET: "[REDACTED]",
      refreshToken: "[REDACTED]",
      apiKey: "[REDACTED]",
      authorization: "[REDACTED]",
    });
  });

  it("redacts nested sensitive fields inside objects and arrays", () => {
    const input = { user: { id: "1", credentials: { password: "hunter2" } }, list: [{ token: "abc" }] };
    expect(redactSensitiveFields(input)).toEqual({
      user: { id: "1", credentials: { password: "[REDACTED]" } },
      list: [{ token: "[REDACTED]" }],
    });
  });

  it("leaves non-sensitive fields untouched", () => {
    const input = { userId: "1", amount: "10.5", status: "OPEN" };
    expect(redactSensitiveFields(input)).toEqual(input);
  });

  it("converts an Error into a plain object (name/message/stack) rather than logging it opaquely", () => {
    const error = new Error("boom");
    const result = redactSensitiveFields(error) as { name: string; message: string; stack: string };
    expect(result.name).toBe("Error");
    expect(result.message).toBe("boom");
    expect(typeof result.stack).toBe("string");
  });

  it("passes through primitives and null unchanged", () => {
    expect(redactSensitiveFields("hello")).toBe("hello");
    expect(redactSensitiveFields(42)).toBe(42);
    expect(redactSensitiveFields(null)).toBeNull();
    expect(redactSensitiveFields(undefined)).toBeUndefined();
  });

  it("never recurses infinitely on a deeply nested object", () => {
    let deep: Record<string, unknown> = { password: "leaf" };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(() => redactSensitiveFields(deep)).not.toThrow();
  });
});
