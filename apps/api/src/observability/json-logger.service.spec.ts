import { JsonLoggerService } from "./json-logger.service";
import { runWithRequestId } from "./request-context";

function lastLoggedEntry(spy: jest.SpyInstance): Record<string, unknown> {
  const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
  return JSON.parse(lastCall[0] as string);
}

describe("JsonLoggerService", () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("emits a single JSON line with timestamp, level, and message", () => {
    const logger = new JsonLoggerService();
    logger.log("hello world");

    const entry = lastLoggedEntry(consoleSpy);
    expect(entry.level).toBe("log");
    expect(entry.message).toBe("hello world");
    expect(typeof entry.timestamp).toBe("string");
  });

  it("treats the trailing string argument as the Nest context, matching ConsoleLogger's own convention", () => {
    const logger = new JsonLoggerService();
    logger.log("something happened", "MyService");

    const entry = lastLoggedEntry(consoleSpy);
    expect(entry.context).toBe("MyService");
    expect(entry.meta).toBeUndefined();
  });

  it("uses the constructor-supplied context when no per-call context is given", () => {
    const logger = new JsonLoggerService("MyService");
    logger.log("hello");

    expect(lastLoggedEntry(consoleSpy).context).toBe("MyService");
  });

  it("expands an Error passed to .error() into a structured name/message/stack object", () => {
    const logger = new JsonLoggerService();
    logger.error("operation failed", new Error("boom"), "MyService");

    const entry = lastLoggedEntry(consoleSpy);
    expect(entry.level).toBe("error");
    expect(entry.context).toBe("MyService");
    expect((entry.meta as unknown[])[0]).toMatchObject({ name: "Error", message: "boom" });
  });

  it("redacts a sensitive field even when it's nested inside logged metadata", () => {
    const logger = new JsonLoggerService();
    logger.log("user action", { userId: "1", password: "hunter2" });

    const entry = lastLoggedEntry(consoleSpy);
    expect((entry.meta as unknown[])[0]).toEqual({ userId: "1", password: "[REDACTED]" });
  });

  it("includes the active request id when one is set", async () => {
    const logger = new JsonLoggerService();
    await runWithRequestId("req-abc", async () => {
      logger.log("inside a request");
    });

    expect(lastLoggedEntry(consoleSpy).requestId).toBe("req-abc");
  });

  it("omits requestId entirely outside of any request context", () => {
    const logger = new JsonLoggerService();
    logger.log("no request context here");

    expect(lastLoggedEntry(consoleSpy).requestId).toBeUndefined();
  });
});
