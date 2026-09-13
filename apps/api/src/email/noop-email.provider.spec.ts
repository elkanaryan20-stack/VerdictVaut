import { NoopEmailProvider } from "./noop-email.provider";

describe("NoopEmailProvider", () => {
  it("never calls fetch — no real network request of any kind", async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;

    await new NoopEmailProvider().sendVerificationEmail({ to: "user@example.com", verificationUrl: "https://app.example.com/verify-email?token=abc" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a result shaped like a real success, but never claims to be a real provider message id", async () => {
    const result = await new NoopEmailProvider().sendVerificationEmail({ to: "user@example.com", verificationUrl: "https://app.example.com/verify-email?token=abc" });
    expect(result.providerMessageId).toMatch(/^noop-/);
  });

  it("never logs the raw verification URL/token", async () => {
    const provider = new NoopEmailProvider();
    const logSpy = jest.spyOn((provider as unknown as { logger: { log: (...args: unknown[]) => void } })["logger"], "log");
    const secretToken = "super-secret-verification-token-value";

    await provider.sendVerificationEmail({ to: "user@example.com", verificationUrl: `https://app.example.com/verify-email?token=${secretToken}` });

    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secretToken);
  });
});
