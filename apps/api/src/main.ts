import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/http-exception.filter";
import { AppConfig } from "./config/configuration";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
