/**
 * Phase 16 — a safeguard against accidentally running a DESTRUCTIVE
 * Prisma migration command (`prisma migrate dev`, which can drop and
 * recreate the database on drift, or `prisma migrate reset`, which
 * always does) against a database that looks like production.
 *
 * This is defense in depth for the common path (the npm scripts below),
 * not a complete guarantee — it only protects invocations that go
 * through `npm run prisma:migrate` / `prisma:migrate:reset`. Someone
 * running `npx prisma migrate dev` directly, or without this repo's
 * environment variables set, bypasses it entirely. The real safeguard
 * is access control on the production database itself (a migration
 * user with DDL rights should never be the same credential the running
 * application uses, and should never be handed to a developer's local
 * shell) — this script exists to catch the honest mistake of running a
 * dev command with a stale DATABASE_URL still pointed at a shared
 * environment, not to substitute for that.
 *
 * Usage: node scripts/guard-destructive-migration.js && <the real command>
 * Exits 1 (refuses) if APP_ENVIRONMENT=production or NODE_ENV=production.
 */
const appEnvironment = (process.env.APP_ENVIRONMENT ?? "").toLowerCase();
const nodeEnv = (process.env.NODE_ENV ?? "").toLowerCase();

if (appEnvironment === "production" || nodeEnv === "production") {
  console.error(
    "REFUSING to run: this command can drop/reset data and must never target a production database.\n" +
      `  APP_ENVIRONMENT=${process.env.APP_ENVIRONMENT ?? "(unset)"}  NODE_ENV=${process.env.NODE_ENV ?? "(unset)"}\n` +
      "  Use `npm run prisma:migrate:deploy` against production instead — it only applies pending migrations, never resets.",
  );
  process.exit(1);
}

process.exit(0);
