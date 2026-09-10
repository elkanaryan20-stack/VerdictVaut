// Every major managed Postgres provider (RDS, Cloud SQL, Supabase,
// Render, Heroku, Neon, ...) documents its own connection string using
// this standard libpq `sslmode` query parameter — never a
// provider-specific flag, so this check needs no provider-specific
// code. `require`/`verify-ca`/`verify-full` all actually encrypt the
// connection; `prefer`/`allow` silently fall back to plaintext if the
// server doesn't offer TLS (unacceptable for production — "prefer" is
// not a real guarantee), and `disable`/unset mean plaintext outright.
const PRODUCTION_SAFE_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * Production must never accept a plaintext or "TLS-if-convenient"
 * database connection — that guarantee belongs in the connection
 * string a real managed provider gives you (via `sslmode`), never a
 * certificate this repo bakes in itself. Local/sandbox Postgres
 * (docker-compose, the embedded integration-test instance) has no TLS
 * listener at all and isn't expected to — this is a no-op outside
 * `appEnvironment === "production"`.
 */
export function assertDatabaseTlsConfigured(databaseUrl: string, appEnvironment: string): void {
  if (appEnvironment !== "production") return;

  let sslmode: string | null;
  try {
    sslmode = new URL(databaseUrl).searchParams.get("sslmode");
  } catch {
    throw new Error("DATABASE_URL is not a valid URL — cannot verify TLS is enforced for production.");
  }

  if (!sslmode || !PRODUCTION_SAFE_SSLMODES.has(sslmode)) {
    throw new Error(
      `APP_ENVIRONMENT=production requires DATABASE_URL to enforce TLS via "?sslmode=require", "verify-ca", ` +
        `or "verify-full" (see your managed Postgres provider's connection-string documentation for the exact ` +
        `value and any client certificate it requires) — got sslmode=${sslmode ?? "(unset)"}. Refusing to start ` +
        `with a plaintext or unverified database connection in production.`,
    );
  }
}
