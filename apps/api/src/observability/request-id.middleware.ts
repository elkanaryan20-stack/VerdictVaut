import { randomUUID } from "crypto";
import { NextFunction, Request, Response } from "express";
import { runWithRequestId } from "./request-context";

const REQUEST_ID_HEADER = "x-request-id";

/**
 * Accepts a caller-supplied `X-Request-Id` (a load balancer or upstream
 * proxy commonly sets one) so a single request can be traced across
 * service boundaries, generating a fresh one only when none is present.
 * Echoes it back on the response so a client/ops engineer can correlate
 * "this HTTP response" with "these log lines" even without log
 * aggregation tooling wired up yet. A plain function, not a NestJS
 * class-based middleware — it has no dependencies to inject, so
 * `app.use(requestIdMiddleware)` in main.ts is simpler than going
 * through a Module's DI-driven `configure()`.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers[REQUEST_ID_HEADER] as string | undefined) || randomUUID();
  res.setHeader("X-Request-Id", requestId);
  runWithRequestId(requestId, next);
}
