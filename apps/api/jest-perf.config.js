/**
 * Phase 38 — performance/scale benchmarks. Reuses the integration suite's
 * embedded-Postgres global setup (throwaway database, real migrations +
 * seed). Deliberately NOT part of `npm test` / CI: timings are
 * machine-dependent, so these report numbers and assert only
 * correctness, never a latency threshold. Run: `npm run perf`.
 */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testRegex: ".*\.perf-spec\.ts$",
  transform: { "^.+\.(t|j)s$": "ts-jest" },
  moduleFileExtensions: ["js", "json", "ts"],
  globalSetup: "<rootDir>/test/integration/global-setup.js",
  globalTeardown: "<rootDir>/test/integration/global-teardown.js",
  setupFilesAfterEnv: ["<rootDir>/test/integration/jest-setup.ts"],
  testTimeout: 1_800_000,
  maxWorkers: 1,
};
