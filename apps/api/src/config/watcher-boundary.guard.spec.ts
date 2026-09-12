import { assertWatchersNotAccidentallyEnabledInApiProcess } from "./watcher-boundary.guard";

describe("assertWatchersNotAccidentallyEnabledInApiProcess", () => {
  it("does not throw when neither watcher is enabled", () => {
    expect(() => assertWatchersNotAccidentallyEnabledInApiProcess({})).not.toThrow();
  });

  it("throws when CHAIN_WATCHER_ENABLED=true and no explicit opt-in is set", () => {
    expect(() => assertWatchersNotAccidentallyEnabledInApiProcess({ CHAIN_WATCHER_ENABLED: "true" })).toThrow(/CHAIN_WATCHER_ENABLED/);
  });

  it("throws when WITHDRAWAL_WATCHER_ENABLED=true and no explicit opt-in is set", () => {
    expect(() => assertWatchersNotAccidentallyEnabledInApiProcess({ WITHDRAWAL_WATCHER_ENABLED: "true" })).toThrow(/WITHDRAWAL_WATCHER_ENABLED/);
  });

  it("does not throw when both watchers are enabled but ALLOW_WATCHERS_IN_API_PROCESS=true", () => {
    expect(() =>
      assertWatchersNotAccidentallyEnabledInApiProcess({
        CHAIN_WATCHER_ENABLED: "true",
        WITHDRAWAL_WATCHER_ENABLED: "true",
        ALLOW_WATCHERS_IN_API_PROCESS: "true",
      }),
    ).not.toThrow();
  });

  it("still throws when ALLOW_WATCHERS_IN_API_PROCESS is set to a non-'true' value", () => {
    expect(() =>
      assertWatchersNotAccidentallyEnabledInApiProcess({ CHAIN_WATCHER_ENABLED: "true", ALLOW_WATCHERS_IN_API_PROCESS: "1" }),
    ).toThrow();
  });
});
