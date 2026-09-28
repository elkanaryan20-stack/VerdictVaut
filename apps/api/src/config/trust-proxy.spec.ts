import express from "express";
import { AddressInfo } from "net";
import { configureTrustProxy } from "./trust-proxy";

/**
 * Phase 37 — proves what req.ip (the key every @Throttle bucket uses)
 * resolves to, against a real Express server on localhost, for requests
 * arriving the way the ALB forwards them (X-Forwarded-For appended).
 */
async function ipSeenFor(hops: number, forwardedFor: string): Promise<string> {
  const app = express();
  configureTrustProxy(app, hops);
  app.get("/", (req, res) => {
    res.send(req.ip);
  });
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { "X-Forwarded-For": forwardedFor } });
    return await response.text();
  } finally {
    server.close();
  }
}

describe("configureTrustProxy (Phase 37)", () => {
  it("without it (hops=0), two different clients behind the proxy resolve to the SAME ip — one shared throttle bucket for everyone", async () => {
    const a = await ipSeenFor(0, "203.0.113.10");
    const b = await ipSeenFor(0, "198.51.100.20");
    expect(a).toBe(b);
    expect(a).not.toBe("203.0.113.10");
  });

  it("with hops=1 (one ALB), each client gets its own ip", async () => {
    expect(await ipSeenFor(1, "203.0.113.10")).toBe("203.0.113.10");
    expect(await ipSeenFor(1, "198.51.100.20")).toBe("198.51.100.20");
  });

  it("with hops=1, a client-forged X-Forwarded-For prefix cannot choose its bucket — only the address the proxy appended counts", async () => {
    // Client sent "X-Forwarded-For: 1.1.1.1"; the ALB appended the real peer.
    expect(await ipSeenFor(1, "1.1.1.1, 203.0.113.10")).toBe("203.0.113.10");
  });

  it("rejects a nonsensical hop count instead of silently trusting everything", () => {
    expect(() => configureTrustProxy({ set: jest.fn() }, -1)).toThrow();
    expect(() => configureTrustProxy({ set: jest.fn() }, 1.5)).toThrow();
    const set = jest.fn();
    configureTrustProxy({ set }, 0);
    expect(set).not.toHaveBeenCalled();
  });
});
