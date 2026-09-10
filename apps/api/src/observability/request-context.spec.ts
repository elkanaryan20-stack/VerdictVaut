import { getRequestId, runWithRequestId } from "./request-context";

describe("request-context", () => {
  it("returns undefined outside of any request context", () => {
    expect(getRequestId()).toBeUndefined();
  });

  it("makes the request id available anywhere inside runWithRequestId's callback, including across awaits", async () => {
    await runWithRequestId("req-123", async () => {
      expect(getRequestId()).toBe("req-123");
      await Promise.resolve();
      expect(getRequestId()).toBe("req-123");
    });
  });

  it("isolates concurrent request contexts from each other", async () => {
    const results: string[] = [];
    await Promise.all([
      runWithRequestId("req-A", async () => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(getRequestId()!);
      }),
      runWithRequestId("req-B", async () => {
        results.push(getRequestId()!);
      }),
    ]);
    expect(results.sort()).toEqual(["req-A", "req-B"]);
  });
});
