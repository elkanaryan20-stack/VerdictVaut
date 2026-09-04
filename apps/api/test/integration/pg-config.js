const path = require("path");

/**
 * Single source of truth for the integration-test Postgres instance.
 * Jest's globalSetup/globalTeardown run in a separate context from the
 * test files themselves, so rather than relying on env-var propagation
 * across that boundary, setup/teardown/tests all import this same config.
 */
module.exports = {
  databaseDir: path.join(__dirname, "..", "..", ".integration-pgdata"),
  user: "verdictvaut_test",
  password: "verdictvaut_test",
  port: 55532,
  database: "verdictvaut_integration",
  get databaseUrl() {
    // Explicit pool size: the concurrency tests intentionally fire ~20
    // simultaneous transactions, which would otherwise queue against
    // Prisma's small default pool and look indistinguishable from a hang.
    return `postgresql://${this.user}:${this.password}@localhost:${this.port}/${this.database}?connection_limit=25&pool_timeout=20`;
  },
};
