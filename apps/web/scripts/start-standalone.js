/**
 * Phase 18 remediation — `next.config.mjs`'s `output: "standalone"`
 * (Phase 16, added for the Docker image) makes plain `next start` print
 * `"next start" does not work with "output: standalone" configuration`
 * and is not the command this app is actually deployed with anywhere —
 * `apps/web/Dockerfile`'s own CMD runs the traced `server.js` directly.
 * This script makes `npm run start` correct for local/staging use by
 * doing exactly what the Dockerfile's COPY instructions do before
 * running that same server.js: standalone output traces only the
 * production dependency subset, so `.next/static` (and `public/`, if
 * present) must be copied alongside it — Next.js does not do this
 * automatically outside of a real Docker build.
 *
 * Safe to run repeatedly — the copies are plain recursive overwrites,
 * not a one-time setup step.
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const webRoot = path.join(__dirname, "..");
const standaloneWebRoot = path.join(webRoot, ".next", "standalone", "apps", "web");
const serverEntry = path.join(standaloneWebRoot, "server.js");

if (!fs.existsSync(serverEntry)) {
  console.error(
    `Standalone server not found at ${serverEntry}.\n` + "Run `npm run build` first (requires next.config.mjs's output: \"standalone\").",
  );
  process.exit(1);
}

fs.cpSync(path.join(webRoot, ".next", "static"), path.join(standaloneWebRoot, ".next", "static"), { recursive: true });

const publicDir = path.join(webRoot, "public");
if (fs.existsSync(publicDir)) {
  fs.cpSync(publicDir, path.join(standaloneWebRoot, "public"), { recursive: true });
}

const child = spawn(process.execPath, ["apps/web/server.js"], {
  cwd: path.join(webRoot, ".next", "standalone"),
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
