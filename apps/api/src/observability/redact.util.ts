// Defense in depth, not the only safeguard — callers still must not log
// secrets deliberately. This exists because a Logger call site is easy
// to get wrong under time pressure (e.g. `logger.error("failed", err)`
// where `err` is an SDK error object that happens to embed the request
// it made, headers and all) and the cost of missing one is a leaked
// credential sitting in a log aggregator indefinitely.
const SENSITIVE_KEY_PATTERN = /password|secret|token|jwt|privatekey|private_key|mnemonic|seed|authorization|cookie|apikey|api_key/i;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;

export function redactSensitiveFields(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveFields(item, depth + 1));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactSensitiveFields(val, depth + 1);
  }
  return result;
}
