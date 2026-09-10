import { AsyncLocalStorage } from "async_hooks";

interface RequestContext {
  requestId: string;
}

// AsyncLocalStorage propagates the request id through every `await`
// inside one request's call stack without threading it through every
// service constructor — the logger reads it here, the middleware below
// is the only thing that ever writes it.
const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
