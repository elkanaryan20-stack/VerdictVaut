/**
 * Phase 16 — the worker container's Docker HEALTHCHECK command. The
 * worker process (worker.main.ts) binds no HTTP port (see its own
 * docblock — that's the whole point of separating it from the API
 * process), so `wget http://localhost/health` — what apps/api/Dockerfile's
 * API stage uses — is not an option here. Liveness is instead judged by
 * a heartbeat file the worker process touches on a timer
 * (WORKER_HEARTBEAT_INTERVAL_MS, default 15s) — this script just checks
 * that file's age.
 *
 * A stale/missing heartbeat means the worker's event loop is not
 * getting to the heartbeat timer (hung, crashed, or never started) —
 * this is liveness only, exactly like GET /health for the API process:
 * it says nothing about whether CHAIN_WATCHER_ENABLED/
 * WITHDRAWAL_WATCHER_ENABLED are even true, or whether a scan is
 * succeeding (see GET /admin/watchers for that operational detail).
 *
 * Usage: node scripts/worker-healthcheck.js
 * Exits 0 (healthy) or 1 (unhealthy) — the shape Docker HEALTHCHECK expects.
 */
const fs = require("fs");

const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE ?? "/tmp/verdictvaut-worker-heartbeat";
// Generous relative to the default 15s write interval — same
// "tolerate one slow tick, not every tick" reasoning as the app's other
// staleness thresholds (LEASE_STALE_AFTER_MS, STALE_CURSOR_THRESHOLD_MS).
const MAX_AGE_MS = parseInt(process.env.WORKER_HEARTBEAT_MAX_AGE_MS ?? "60000", 10);

try {
  const stat = fs.statSync(HEARTBEAT_FILE);
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > MAX_AGE_MS) {
    console.error(`Worker heartbeat is stale: last written ${ageMs}ms ago (max ${MAX_AGE_MS}ms) — ${HEARTBEAT_FILE}`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(`Worker heartbeat file unreadable: ${error.message} — ${HEARTBEAT_FILE}`);
  process.exit(1);
}
