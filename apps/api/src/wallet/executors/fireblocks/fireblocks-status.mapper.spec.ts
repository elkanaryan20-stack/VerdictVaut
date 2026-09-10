import {
  mapFireblocksResponseToExecutionResult,
  mapFireblocksResponseToStatusLookup,
  UnrecognizedFireblocksStatusError,
} from "./fireblocks-status.mapper";

describe("mapFireblocksResponseToExecutionResult", () => {
  it.each(["SUBMITTED", "PENDING_AML_SCREENING", "PENDING_ENRICHMENT", "PENDING_AUTHORIZATION", "QUEUED", "PENDING_SIGNATURE", "SIGNED", "PENDING_3RD_PARTY_MANUAL_APPROVAL", "PENDING_3RD_PARTY", "CANCELLING"])(
    "maps pending status %s to awaiting_manual_broadcast with the provider reference, never a txHash",
    (status) => {
      const result = mapFireblocksResponseToExecutionResult({ id: "fb-1", status });
      expect(result).toEqual({ status: "awaiting_manual_broadcast", providerReference: "fb-1" });
    },
  );

  it.each(["BROADCASTING", "CONFIRMING", "COMPLETED"])("maps broadcast status %s with a txHash to a real broadcast result", (status) => {
    const result = mapFireblocksResponseToExecutionResult({ id: "fb-1", status, txHash: "0xreal" });
    expect(result).toEqual({ status: "broadcast", txHash: "0xreal", providerReference: "fb-1" });
  });

  it("never fabricates a txHash — a broadcast-stage status with no txHash is reported ambiguous, not guessed", () => {
    const result = mapFireblocksResponseToExecutionResult({ id: "fb-1", status: "BROADCASTING" });
    expect(result.status).toBe("ambiguous");
  });

  it.each(["BLOCKED", "REJECTED", "FAILED", "CANCELLED"])("throws a plain error for definitive rejection status %s — never 'ambiguous' for a known outcome", (status) => {
    expect(() => mapFireblocksResponseToExecutionResult({ id: "fb-1", status })).toThrow(/did not execute/);
  });

  it("throws UnrecognizedFireblocksStatusError for a status outside the verified list, rather than guessing", () => {
    expect(() => mapFireblocksResponseToExecutionResult({ id: "fb-1", status: "SOME_FUTURE_STATUS" })).toThrow(UnrecognizedFireblocksStatusError);
  });
});

describe("mapFireblocksResponseToStatusLookup", () => {
  it("maps a rejected status to status: rejected with a reason", () => {
    expect(mapFireblocksResponseToStatusLookup({ id: "fb-1", status: "REJECTED" })).toEqual({
      status: "rejected",
      providerReference: "fb-1",
      reason: "Fireblocks status REJECTED",
    });
  });

  it("maps COMPLETED with a txHash to status: broadcast", () => {
    expect(mapFireblocksResponseToStatusLookup({ id: "fb-1", status: "COMPLETED", txHash: "0xreal" })).toEqual({
      status: "broadcast",
      txHash: "0xreal",
      providerReference: "fb-1",
    });
  });

  it("maps a pending status to status: pending", () => {
    expect(mapFireblocksResponseToStatusLookup({ id: "fb-1", status: "QUEUED" })).toEqual({ status: "pending", providerReference: "fb-1" });
  });
});
