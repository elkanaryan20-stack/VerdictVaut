import { Injectable, Logger } from "@nestjs/common";

export type MetricTags = Record<string, string | number | boolean>;

/**
 * Provider-neutral metrics boundary (Phase 13 remediation item 4) — the
 * "smallest useful production foundation" the phase asked for, not a
 * monitoring platform. Application code depends on this abstract class
 * only; wiring a real backend (Prometheus, Datadog, CloudWatch metrics,
 * StatsD, ...) later means implementing these same three methods and
 * swapping the binding in observability.module.ts — nothing else in
 * the codebase changes. No vendor is chosen or assumed here.
 */
@Injectable()
export abstract class MetricsService {
  abstract increment(name: string, tags?: MetricTags): void;
  abstract gauge(name: string, value: number, tags?: MetricTags): void;
  abstract timing(name: string, durationMs: number, tags?: MetricTags): void;
}

/**
 * Default binding: logs each metric event as a structured log line
 * (so it's visible in whatever log aggregator is already receiving
 * this app's JSON logs — see json-logger.service.ts) rather than
 * silently discarding it or pretending to ship it to a real metrics
 * backend that isn't configured. Real alerting on these events today
 * means alerting on the log line itself (e.g. a log-based metric/alert
 * in whatever aggregator is chosen); replacing this class is what
 * "real" metrics infrastructure looks like once a provider is picked.
 */
@Injectable()
export class LoggingMetricsService extends MetricsService {
  private readonly logger = new Logger("Metrics");

  increment(name: string, tags?: MetricTags): void {
    this.logger.log({ metric: name, type: "increment", value: 1, tags });
  }

  gauge(name: string, value: number, tags?: MetricTags): void {
    this.logger.log({ metric: name, type: "gauge", value, tags });
  }

  timing(name: string, durationMs: number, tags?: MetricTags): void {
    this.logger.log({ metric: name, type: "timing", value: durationMs, tags });
  }
}
