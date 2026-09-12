/**
 * Phase 16 — enforces the deployment boundary between the HTTP API
 * process (main.ts) and the dedicated background-worker process
 * (worker.main.ts): the API process must never silently start scanning
 * blockchains or polling withdrawal confirmations just because someone
 * copied the worker's environment variables onto the wrong deployment.
 *
 * Deliberately a plain function reading `process.env` directly, called
 * at the very top of main.ts's bootstrap() BEFORE NestFactory.create()
 * — DepositWatcherService/WithdrawalWatcherService start their polling
 * timers from OnModuleInit, which runs DURING app creation, so any
 * check performed after `NestFactory.create()` returns would already be
 * too late. worker.main.ts never calls this guard — running watchers is
 * exactly what that process is for.
 */
export function assertWatchersNotAccidentallyEnabledInApiProcess(env: NodeJS.ProcessEnv = process.env): void {
  const chainWatcherEnabled = env.CHAIN_WATCHER_ENABLED === "true";
  const withdrawalWatcherEnabled = env.WITHDRAWAL_WATCHER_ENABLED === "true";
  const allowed = env.ALLOW_WATCHERS_IN_API_PROCESS === "true";

  if (!allowed && (chainWatcherEnabled || withdrawalWatcherEnabled)) {
    const enabledFlags = [
      chainWatcherEnabled ? "CHAIN_WATCHER_ENABLED" : null,
      withdrawalWatcherEnabled ? "WITHDRAWAL_WATCHER_ENABLED" : null,
    ].filter(Boolean);
    throw new Error(
      `The HTTP API process refuses to start with ${enabledFlags.join(" and ")}=true: background blockchain workers ` +
        "belong in the dedicated worker process (run `node dist/worker.main.js`, see docs/deployment-architecture.md), " +
        "not inside the process serving HTTP traffic. If this is a deliberate single-process deployment, set " +
        "ALLOW_WATCHERS_IN_API_PROCESS=true to explicitly opt in.",
    );
  }
}
