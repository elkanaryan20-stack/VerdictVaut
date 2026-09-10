import { ConsoleLogger, LogLevel, LoggerService } from "@nestjs/common";
import { getRequestId } from "./request-context";
import { redactSensitiveFields } from "./redact.util";

/**
 * One JSON object per log line — the smallest useful production
 * foundation for logging (Phase 13 remediation item 4): every line
 * carries a timestamp, level, the Nest "context" (component name,
 * exactly what ConsoleLogger already shows in brackets), the current
 * request id when one is active (see request-context.ts), and whatever
 * else the call site passed, run through redactSensitiveFields first.
 *
 * Deliberately NOT a new logging framework/dependency (pino/winston) —
 * this wraps Nest's own ConsoleLogger call conventions (see
 * logger.service.js: the last positional arg is the "context" string
 * for log/warn/debug/verbose; for error it's [detail?, context?])
 * rather than replacing them, so every existing `new Logger(X)` call
 * site in this codebase gets structured output for free with zero
 * changes elsewhere.
 *
 * Where this connects to real infrastructure: ship stdout (this writes
 * to it, one JSON object per line, exactly what every container log
 * driver / log-aggregation agent expects) to whatever log aggregator is
 * chosen for the deployment target (CloudWatch Logs, Datadog, Loki,
 * ELK, ...) — none is invented or assumed here.
 */
export class JsonLoggerService extends ConsoleLogger implements LoggerService {
  private write(level: LogLevel, message: unknown, meta: unknown[], context?: string) {
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      context: context ?? this.context,
      message: redactSensitiveFields(message),
    };
    const requestId = getRequestId();
    if (requestId) entry.requestId = requestId;
    if (meta.length > 0) entry.meta = meta.map((m) => redactSensitiveFields(m));

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));
  }

  private splitContext(optionalParams: unknown[]): { context?: string; rest: unknown[] } {
    if (optionalParams.length === 0) return { rest: [] };
    const last = optionalParams[optionalParams.length - 1];
    if (typeof last === "string") {
      return { context: last, rest: optionalParams.slice(0, -1) };
    }
    return { rest: optionalParams };
  }

  log(message: unknown, ...optionalParams: unknown[]) {
    const { context, rest } = this.splitContext(optionalParams);
    this.write("log", message, rest, context);
  }

  warn(message: unknown, ...optionalParams: unknown[]) {
    const { context, rest } = this.splitContext(optionalParams);
    this.write("warn", message, rest, context);
  }

  debug(message: unknown, ...optionalParams: unknown[]) {
    const { context, rest } = this.splitContext(optionalParams);
    this.write("debug", message, rest, context);
  }

  verbose(message: unknown, ...optionalParams: unknown[]) {
    const { context, rest } = this.splitContext(optionalParams);
    this.write("verbose", message, rest, context);
  }

  error(message: unknown, ...optionalParams: unknown[]) {
    const { context, rest } = this.splitContext(optionalParams);
    // Nest's convention: the remaining single param (if any) is either
    // a stack-trace string or the Error itself, depending on how the
    // call site invoked .error(). Normalize both into the same shape.
    const [detail] = rest;
    const meta: unknown[] =
      detail instanceof Error
        ? [{ name: detail.name, message: detail.message, stack: detail.stack }]
        : rest.length > 0
          ? rest
          : [];
    this.write("error", message, meta, context);
  }
}
