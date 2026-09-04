const EmbeddedPostgres = require("embedded-postgres").default;
const config = require("./pg-config");

module.exports = async function globalTeardown() {
  const pg = new EmbeddedPostgres({
    databaseDir: config.databaseDir,
    user: config.user,
    password: config.password,
    port: config.port,
    persistent: false,
  });

  try {
    await pg.stop();
  } catch {
    // best-effort — the data directory is disposable and gitignored either way
  }
};
