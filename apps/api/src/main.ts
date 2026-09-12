import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/http-exception.filter";
import { AppConfig } from "./config/configuration";
import { assertWatchersNotAccidentallyEnabledInApiProcess } from "./config/watcher-boundary.guard";
import { JsonLoggerService } from "./observability/json-logger.service";
import { requestIdMiddleware } from "./observability/request-id.middleware";

async function bootstrap() {
  // Must run BEFORE NestFactory.create() — DepositWatcherService/
  // WithdrawalWatcherService start their polling timers from
  // OnModuleInit, which fires DURING app creation, so checking this
  // afterward would already be too late. See the guard's own docblock.
  assertWatchersNotAccidentallyEnabledInApiProcess();

  // Passed via options (not app.useLogger() after the fact) so even
  // Nest's own bootstrap-time framework log lines come out as
  // structured JSON, not just application code's own logging.
  // rawBody: true (a standard NestJS option) exposes req.rawBody — the
  // exact bytes a provider webhook signed, needed to verify its
  // signature (JSON.stringify(JSON.parse(body)) is not guaranteed to
  // byte-for-byte match what was actually signed) — see
  // FireblocksWebhookController.
  const app = await NestFactory.create(AppModule, { logger: new JsonLoggerService(), rawBody: true });

  // Phase 16 fix — without this, Nest never calls app.close() on SIGTERM/
  // SIGINT, which means OnModuleDestroy (including DepositWatcherService/
  // WithdrawalWatcherService's graceful-shutdown wait for an in-flight
  // poll — see their own onModuleDestroy docblocks) never runs for THIS
  // process. That previously left the ALLOW_WATCHERS_IN_API_PROCESS=true
  // single-process deployment mode with no graceful shutdown at all,
  // even though watcher-boundary.guard.ts's job is only to stop watchers
  // from running here BY ACCIDENT — a deliberate single-process
  // deployment still deserves the same safe-shutdown behavior
  // worker.main.ts already has. Registering this here changes nothing
  // about whether watchers run in this process (that's still entirely
  // decided by watcher-boundary.guard.ts, above, and the CHAIN_WATCHER_ENABLED/
  // WITHDRAWAL_WATCHER_ENABLED flags) — it only ensures that IF they do
  // run here, shutting this process down is as safe as shutting down the
  // dedicated worker process.
  app.enableShutdownHooks();

  // Assigns/propagates a request id (see observability/request-context.ts)
  // BEFORE any other middleware/guard/handler runs, so every log line
  // for a request — including ones from guards that reject it — carries
  // the same id a client can correlate against the X-Request-Id response header.
  app.use(requestIdMiddleware);

  // Sensible baseline security headers (HSTS, no-sniff, frame-deny,
  // referrer policy, etc.) — see the whole eslint-disable-free default
  // set at https://helmetjs.github.io/. `contentSecurityPolicy` is left
  // off: this API serves no HTML/browser-rendered content of its own
  // (the frontend is a separate Next.js app), and a default CSP tuned
  // for a JSON API rather than a real content policy would be
  // security-theater, not real protection.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get("port", { infer: true });
  const nodeEnv = config.get("nodeEnv", { infer: true });
  const corsAllowedOrigins = config.get("corsAllowedOrigins", { infer: true });

  // Wide-open CORS only in local development; everywhere else this fails
  // closed to an explicit allowlist (empty by default — set
  // CORS_ALLOWED_ORIGINS to enable specific origins).
  app.enableCors(nodeEnv === "development" ? {} : { origin: corsAllowedOrigins, credentials: true });

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`VerdictVaut API listening on port ${port} (environment: ${config.get("appEnvironment", { infer: true })})`);
}

bootstrap();
