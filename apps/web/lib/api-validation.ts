import { z } from "zod";

export class MalformedResponseError extends Error {
  constructor(context: string, issues: string) {
    super(`Unexpected data shape from the server (${context}): ${issues}`);
    this.name = "MalformedResponseError";
  }
}

/**
 * Every response any domain (wallet, trading, ...) treats as financial
 * fact is validated against its shared Zod schema before anything
 * renders it — a malformed or unexpectedly-shaped backend response
 * surfaces as a clear "something went wrong" error state, never as a
 * silently wrong number on screen or a raw runtime crash deep in a
 * component.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, context: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new MalformedResponseError(context, result.error.issues.map((issue) => issue.message).join("; "));
  }
  return result.data;
}
