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
  app.enableCors();

  const config = app.get(ConfigService<AppConfig, true>);
  const port = config.get("port", { infer: true });

  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`VerdictVaut API listening on port ${port} (environment: ${config.get("appEnvironment", { infer: true })})`);
}

bootstrap();
