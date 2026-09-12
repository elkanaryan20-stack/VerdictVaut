import "reflect-metadata";
import * as fs from "fs";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { AppConfig } from "./config/configuration";
import { JsonLoggerService } from "./observability/json-logger.service";

const CONTEXT = "WorkerBootstrap";

/**
 * Phase 16 — the dedicated background-worker process: hosts
 * DepositWatcherService/WithdrawalWatcherService (and everything they
 * depend on) with NO HTTP surface at all, independent of the API
 * process (main.ts). Run as `node dist/worker.main.js`; which watchers
 * actually start is still controlled by the same CHAIN_WATCHER_ENABLED
 * / WITHDRAWAL_WATCHER_ENABLED flags those services already read — this
 * file only changes WHERE they run, not whether they're enabled.
 *
 * Reuses AppModule (not a separate, hand-maintained worker module) so
 * every provider binding (CustodyProviderFactory, WithdrawalExecutorFactory,
 * ComplianceGateFactory, ProductionSafetyGate, ...) is guaranteed
 * identical to what the API process resolves — a hand-duplicated module
 * graph could silently drift and resolve a different implementation in
 * one process than the other. createApplicationContext() never binds an
 * HTTP listener, so AppModule's controllers (including the Fireblocks
 * webhook receiver, which belongs on the API process only) are
 * instantiated as plain providers but reachable by no one — no port is
 * opened here at all.
 */
async function bootstrap() {
  const logger = new JsonLoggerService();
  const app = await NestFactory.createApplicationContext(AppModule, { logger });

  const config = app.get(ConfigService<AppConfig, true>);
  const chainWatcher = config.get("chainWatcher", { infer: true });
  const withdrawalWatcher = config.get("withdrawalWatcher", { infer: true });
  if (!chainWatcher.enabled && !withdrawalWatcher.enabled) {
    logger.warn(
      "Worker process started but BOTH CHAIN_WATCHER_ENABLED and WITHDRAWAL_WATCHER_ENABLED are false — this process " +
        "is not doing anything. Set one or both to true, or this is likely a misconfigured deployment.",
      CONTEXT,
    );
  }

  const workerConfig = config.get("worker", { infer: true });
  const writeHeartbeat = () => {
    try {
      fs.writeFileSync(workerConfig.heartbeatFile, new Date().toISOString());
    } catch (error) {
      // A heartbeat write failure (e.g. read-only filesystem, missing
      // directory) must never crash the worker — it only degrades
      // container-orchestrator liveness visibility (see
      // scripts/worker-healthcheck.js), not the watchers' own safety
      // properties, which do not depend on this file at all.
      logger.error("Failed to write worker heartbeat file", (error as Error).stack ?? String(error), CONTEXT);
    }
  };
  writeHeartbeat();
  const heartbeatTimer = setInterval(writeHeartbeat, workerConfig.heartbeatIntervalMs);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`Worker process received ${signal} — shutting down gracefully`, CONTEXT);
    clearInterval(heartbeatTimer);
    // app.close() runs every module's OnModuleDestroy, including the
    // watchers' own graceful-shutdown logic (stop accepting new poll
    // ticks, then wait for any in-flight poll to finish before
    // returning — see DepositWatcherService/WithdrawalWatcherService).
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.log(
    `VerdictVaut background worker process started (no HTTP surface) — chainWatcher.enabled=${chainWatcher.enabled}, withdrawalWatcher.enabled=${withdrawalWatcher.enabled}`,
    CONTEXT,
  );
}

bootstrap();
