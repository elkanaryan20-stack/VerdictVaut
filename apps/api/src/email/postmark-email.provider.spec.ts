import { PostmarkEmailProvider } from "./postmark-email.provider";
import { PostmarkApiError } from "./postmark-http.util";

describe("PostmarkEmailProvider", () => {
  let fetchMock: jest.Mock;
  let metrics: { increment: jest.Mock; gauge: jest.Mock; timing: jest.Mock };
  let provider: PostmarkEmailProvider;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    metrics = { increment: jest.fn(), gauge: jest.fn(), timing: jest.fn() };
    provider = new PostmarkEmailProvider({ serverToken: "test-token", fromAddress: "noreply@verdictvaut.test" }, metrics as never);
  });

  it("sends From/To/Subject/HtmlBody/TextBody and returns the real providerMessageId Postmark returned", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ MessageID: "real-msg-1", ErrorCode: 0, Message: "OK" }) });

    const result = await provider.sendVerificationEmail({ to: "user@example.com", verificationUrl: "https://app.example.com/verify-email?token=abc123" });

    expect(result.providerMessageId).toBe("real-msg-1");
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.From).toBe("noreply@verdictvaut.test");
    expect(body.To).toBe("user@example.com");
    expect(body.HtmlBody).toEqual(expect.any(String));
    expect(body.TextBody).toEqual(expect.any(String));
  });

  it("never fabricates a providerMessageId on failure — throws instead", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ ErrorCode: 10, Message: "Invalid server token" }) });
    await expect(
      provider.sendVerificationEmail({ to: "user@example.com", verificationUrl: "https://app.example.com/verify-email?token=abc123" }),
    ).rejects.toBeInstanceOf(PostmarkApiError);
  });

  it("increments failure metrics with a classified error tag on a provider rejection", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422, text: async () => JSON.stringify({ ErrorCode: 406, Message: "inactive recipient" }) });
    await expect(provider.sendVerificationEmail({ to: "user@example.com", verificationUrl: "https://app.example.com/verify-email?token=abc" })).rejects.toThrow();
    expect(metrics.increment).toHaveBeenCalledWith("email_provider_request_failures_total", expect.objectContaining({ errorClass: "http_422" }));
  });

  it("times out and throws rather than hanging when Postmark never responds", async () => {
    fetchMock.mockImplementation(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    await expect(provider.sendVerificationEmail({ to: "user@example.com", verificationUrl: "https://app.example.com/verify-email?token=abc" })).rejects.toThrow();
  }, 15000);

  it("never includes the raw verification URL/token or the server token in any logged call argument", async () => {
    const logSpy = jest.spyOn((provider as unknown as { logger: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void } })["logger"], "log");
    const errorSpy = jest.spyOn((provider as unknown as { logger: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void } })["logger"], "error");
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ MessageID: "msg-1", ErrorCode: 0, Message: "OK" }) });

    const secretToken = "super-secret-verification-token-value";
    await provider.sendVerificationEmail({ to: "user@example.com", verificationUrl: `https://app.example.com/verify-email?token=${secretToken}` });

    const allLoggedArgs = JSON.stringify([...logSpy.mock.calls, ...errorSpy.mock.calls]);
    expect(allLoggedArgs).not.toContain(secretToken);
    expect(allLoggedArgs).not.toContain("test-token"); // the server token constructor arg above
  });
});
