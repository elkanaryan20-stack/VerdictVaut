import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../observability/metrics.service";
import { EMAIL_PROVIDER } from "./email-provider.interface";
import { emailProviderFactory } from "./email-provider.factory";

@Module({
  providers: [
    {
      provide: EMAIL_PROVIDER,
      // MetricsService is bound by the @Global ObservabilityModule, so
      // it resolves here without EmailModule needing to import it
      // explicitly — same as every other module in this codebase that
      // injects MetricsService.
      inject: [ConfigService, MetricsService],
      useFactory: (config: ConfigService<AppConfig, true>, metrics: MetricsService) => emailProviderFactory(config, metrics),
    },
  ],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
