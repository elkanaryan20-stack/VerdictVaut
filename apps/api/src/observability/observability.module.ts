import { Global, Module } from "@nestjs/common";
import { LoggingMetricsService, MetricsService } from "./metrics.service";

@Global()
@Module({
  providers: [{ provide: MetricsService, useClass: LoggingMetricsService }],
  exports: [MetricsService],
})
export class ObservabilityModule {}
