const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");
const EmbeddedPostgres = require("embedded-postgres").default;
const config = require("./pg-config");

module.exports = async function globalSetup() {
  if (fs.existsSync(config.databaseDir)) {
    fs.rmSync(config.databaseDir, { recursive: true, force: true });
  }

  const pg = new EmbeddedPostgres({
    databaseDir: config.databaseDir,
    user: config.user,
    password: config.password,
    port: config.port,
    persistent: false,
    // Without this, initdb defaults to the HOST OS's locale/codepage —
    // on Windows that's typically WIN1252, not UTF8. A real production
    // Postgres is virtually always UTF8 (every managed provider defaults
    // to it), so a test DB silently running WIN1252 hides bugs rather
    // than catching them: any text containing non-ASCII bytes (Prisma's
    // own error messages sometimes embed a "→" code-frame pointer)
    // fails to INSERT/UPDATE with an encoding error instead of the
    // value it's supposed to hold, on Windows dev machines only —
    // exactly the kind of environment-specific false pass Phase 13's
    // "do not make it artificially pass" instruction warns against.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase(config.database);

  // Apply the real, committed migrations against a real Postgres — this
  // is both the fixture setup for every integration test AND the
  // migration-correctness check itself (a broken migration fails here,
  // not silently).
  execSync("npx prisma migrate deploy", {
    cwd: path.join(__dirname, "..", ".."),
    env: { ...process.env, DATABASE_URL: config.databaseUrl },
    stdio: "inherit",
  });

  execSync("npx prisma db seed", {
    cwd: path.join(__dirname, "..", ".."),
    env: { ...process.env, DATABASE_URL: config.databaseUrl },
    stdio: "inherit",
  });

  // globalTeardown runs in a separate process/context and can't share
  // this in-memory `pg` handle, so it recreates its own pointed at the
  // same databaseDir/port to issue the stop.
};
