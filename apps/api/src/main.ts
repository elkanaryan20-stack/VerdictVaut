import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/http-exception.filter";
import { AppConfig } from "./config/configuration";
import { JsonLoggerService } from "./observability/json-logger.service";
import { requestIdMiddleware } from "./observability/request-id.middleware";

async function bootstrap() {
  // Passed via options (not app.useLogger() after the fact) so even
  // Nest's own bootstrap-time framework log lines come out as
  // structured JSON, not just application code's own logging.
  const app = await NestFactory.create(AppModule, { logger: new JsonLoggerService() });

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
