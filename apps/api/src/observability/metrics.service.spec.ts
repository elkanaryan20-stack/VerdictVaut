import { LoggingMetricsService } from "./metrics.service";

// LoggingMetricsService logs through Nest's own `Logger` wrapper (so it
// automatically benefits from whichever logger implementation the app
// is actually running — JsonLoggerService in production, per
// main.ts). In a plain unit test with no app.useLogger() override,
// that resolves to Nest's default ConsoleLogger, which writes to
// process.stdout, not console.log — spy on that instead of assuming
// a specific logger implementation is active.
function captureStdout(fn: () => void): string {
  const spy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    fn();
    return spy.mock.calls.map((c) => String(c[0])).join("\n");
  } finally {
    spy.mockRestore();
  }
}

describe("LoggingMetricsService", () => {
  it("logs an increment with its name, value, and tags", () => {
    const output = captureStdout(() => {
      new LoggingMetricsService().increment("wallet.deposit_watcher.scan_failed", { assetNetworkId: "an-1" });
    });
    expect(output).toContain("wallet.deposit_watcher.scan_failed");
    expect(output).toContain("increment");
    expect(output).toContain("an-1");
  });

  it("logs a gauge and a timing with their given values", () => {
    const metrics = new LoggingMetricsService();
    const gaugeOutput = captureStdout(() => metrics.gauge("queue.depth", 42));
    const timingOutput = captureStdout(() => metrics.timing("request.duration_ms", 123));

    expect(gaugeOutput).toContain("queue.depth");
    expect(gaugeOutput).toContain("42");
    expect(timingOutput).toContain("request.duration_ms");
    expect(timingOutput).toContain("123");
  });
});
