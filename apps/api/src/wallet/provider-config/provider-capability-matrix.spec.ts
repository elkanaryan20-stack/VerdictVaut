import { NetworkFamily } from "@prisma/client";
import { PROVIDER_CAPABILITY_MATRIX } from "./provider-capability-matrix";

describe("PROVIDER_CAPABILITY_MATRIX", () => {
  it("has exactly one entry per (provider, capability, networkFamily) combination actually present", () => {
    const seen = new Set<string>();
    for (const entry of PROVIDER_CAPABILITY_MATRIX) {
      const key = `${entry.provider}:${entry.capability}:${entry.networkFamily}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("every entry has a non-empty note explaining its status", () => {
    for (const entry of PROVIDER_CAPABILITY_MATRIX) {
      expect(entry.note.length).toBeGreaterThan(20);
    }
  });

  it("chainalysis is UNSUPPORTED for every network family — never claimed as implemented", () => {
    const chainalysisEntries = PROVIDER_CAPABILITY_MATRIX.filter((e) => e.provider === "chainalysis");
    expect(chainalysisEntries.length).toBe(4);
    for (const entry of chainalysisEntries) {
      expect(entry.status).toBe("UNSUPPORTED");
    }
  });

  it("matches the real, coded fail-closed behavior: Fireblocks custody execution is UNSUPPORTED for XRPL", () => {
    const xrplFireblocks = PROVIDER_CAPABILITY_MATRIX.find((e) => e.provider === "fireblocks" && e.networkFamily === NetworkFamily.XRPL);
    expect(xrplFireblocks?.status).toBe("UNSUPPORTED");
  });

  it("Fireblocks custody execution is UNVERIFIED (not VERIFIED) for every network family it is not UNSUPPORTED for — documentation covers most, but not all, of the real request shape", () => {
    for (const entry of PROVIDER_CAPABILITY_MATRIX.filter((e) => e.provider === "fireblocks" && e.status !== "UNSUPPORTED")) {
      expect(entry.status).toBe("UNVERIFIED");
    }
  });

  it("matches the real, coded fail-closed behavior: Elliptic address-risk screening is VERIFIED only for EVM", () => {
    for (const entry of PROVIDER_CAPABILITY_MATRIX.filter((e) => e.provider === "elliptic")) {
      if (entry.networkFamily === NetworkFamily.EVM) {
        expect(entry.status).toBe("VERIFIED");
      } else {
        expect(entry.status).toBe("UNSUPPORTED");
      }
    }
  });

  it("Phase 14B.1: no row is liveVerified — nothing in this matrix has ever been exercised against a real provider sandbox account", () => {
    for (const entry of PROVIDER_CAPABILITY_MATRIX) {
      expect(entry.liveVerified).toBe(false);
    }
  });

  it("a VERIFIED (documentation-level) row can still be liveVerified:false — the two are independent facts", () => {
    const verifiedRows = PROVIDER_CAPABILITY_MATRIX.filter((e) => e.status === "VERIFIED");
    expect(verifiedRows.length).toBeGreaterThan(0);
    for (const entry of verifiedRows) {
      expect(entry.liveVerified).toBe(false);
    }
  });
});
