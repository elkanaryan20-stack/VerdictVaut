import { Request, Response } from "express";
import { requestIdMiddleware } from "./request-id.middleware";
import { getRequestId } from "./request-context";

function makeReqRes(headers: Record<string, string> = {}) {
  const setHeader = jest.fn();
  const req = { headers } as unknown as Request;
  const res = { setHeader } as unknown as Response;
  return { req, res, setHeader };
}

describe("requestIdMiddleware", () => {
  it("generates a fresh request id when none is supplied and makes it available via getRequestId inside next()", () => {
    const { req, res, setHeader } = makeReqRes();
    let seenInside: string | undefined;

    requestIdMiddleware(req, res, () => {
      seenInside = getRequestId();
    });

    expect(seenInside).toBeTruthy();
    expect(setHeader).toHaveBeenCalledWith("X-Request-Id", seenInside);
  });

  it("reuses a caller-supplied X-Request-Id rather than generating a new one", () => {
    const { req, res, setHeader } = makeReqRes({ "x-request-id": "upstream-id-123" });
    let seenInside: string | undefined;

    requestIdMiddleware(req, res, () => {
      seenInside = getRequestId();
    });

    expect(seenInside).toBe("upstream-id-123");
    expect(setHeader).toHaveBeenCalledWith("X-Request-Id", "upstream-id-123");
  });

  it("is not visible outside of the request it was set for", () => {
    const { req, res } = makeReqRes();
    requestIdMiddleware(req, res, () => undefined);
    expect(getRequestId()).toBeUndefined();
  });
});
