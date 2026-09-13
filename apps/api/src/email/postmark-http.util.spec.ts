import { postmarkRequest, PostmarkApiError, PostmarkMalformedResponseError, PostmarkTransportError } from "./postmark-http.util";

/**
 * Mocks the global `fetch` to simulate DOCUMENTED Postmark response
 * shapes (per Postmark's own published API reference, fetched this
 * session — see postmark-http.util.ts's own docblock). No real network
 * call to Postmark is made anywhere in this file, and no real email is
 * ever sent by any automated test.
 */
describe("postmarkRequest", () => {
  const config = { serverToken: "test-server-token", timeoutMs: 5000 };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });

  it("calls the documented Postmark send-email URL with X-Postmark-Server-Token and never logs/exposes the token elsewhere", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ To: "a@example.com", MessageID: "msg-1", ErrorCode: 0, Message: "OK" }) });

    await postmarkRequest(config, { From: "noreply@example.com", To: "a@example.com", Subject: "s", HtmlBody: "<p>h</p>", TextBody: "t" });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect(options.headers["X-Postmark-Server-Token"]).toBe("test-server-token");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.headers["Accept"]).toBe("application/json");
  });

  it("sends the request body exactly as given, with no invented fields", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ MessageID: "msg-1", ErrorCode: 0, Message: "OK" }) });
    const body = { From: "noreply@example.com", To: "a@example.com", Subject: "s", HtmlBody: "<p>h</p>", TextBody: "t" };

    await postmarkRequest(config, body);

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual(body);
  });

  it("parses a successful JSON response, exposing the documented MessageID field", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ To: "a@example.com", SubmittedAt: "2024-01-01T00:00:00Z", MessageID: "msg-real-1", ErrorCode: 0, Message: "OK" }) });
    const result = await postmarkRequest<{ MessageID: string }>(config, {});
    expect(result.MessageID).toBe("msg-real-1");
  });

  it("throws PostmarkApiError with status 401 for an invalid server token", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ ErrorCode: 10, Message: "Invalid server token" }) });
    await expect(postmarkRequest(config, {})).rejects.toMatchObject({ status: 401 });
  });

  it("throws PostmarkApiError with status 422 for an inactive/bounced recipient (documented ErrorCode 406)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422, text: async () => JSON.stringify({ ErrorCode: 406, Message: "recipient marked as inactive" }) });
    await expect(postmarkRequest(config, {})).rejects.toBeInstanceOf(PostmarkApiError);
  });

  it("throws PostmarkMalformedResponseError when the body isn't valid JSON", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "<html>not json</html>" });
    await expect(postmarkRequest(config, {})).rejects.toBeInstanceOf(PostmarkMalformedResponseError);
  });

  it("throws PostmarkTransportError when fetch itself rejects (network error)", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    await expect(postmarkRequest(config, {})).rejects.toBeInstanceOf(PostmarkTransportError);
  });

  it("aborts and rejects via PostmarkTransportError when the request exceeds the configured timeout", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
        }),
    );

    const promise = postmarkRequest({ serverToken: "t", timeoutMs: 1000 }, {});
    const assertion = expect(promise).rejects.toBeInstanceOf(PostmarkTransportError);
    jest.advanceTimersByTime(1000);
    await assertion;
    jest.useRealTimers();
  });
});
