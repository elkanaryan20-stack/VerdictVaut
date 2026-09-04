/** Real-Postgres concurrency/integration tests — separate from the fast, mocked unit suite. */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testRegex: ".*\\.integration-spec\\.ts$",
  transform: { "^.+\\.(t|j)s$": "ts-jest" },
  moduleFileExtensions: ["js", "json", "ts"],
  globalSetup: "<rootDir>/test/integration/global-setup.js",
  globalTeardown: "<rootDir>/test/integration/global-teardown.js",
  setupFilesAfterEnv: ["<rootDir>/test/integration/jest-setup.ts"],
  testTimeout: 30000,
  maxWorkers: 1,
};
