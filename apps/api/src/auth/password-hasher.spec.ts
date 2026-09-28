import * as bcrypt from "bcryptjs";
import { comparePassword, hashPassword } from "./password-hasher";

describe("password-hasher (Phase 38 — bcryptjs on worker threads)", () => {
  it("round-trips: a hash produced in the pool verifies in the pool", async () => {
    const hash = await hashPassword("correct horse battery staple", 4);
    await expect(comparePassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(comparePassword("wrong password", hash)).resolves.toBe(false);
  });

  it("is format-compatible with existing main-thread bcryptjs hashes in both directions (no user re-hash needed)", async () => {
    const legacy = await bcrypt.hash("legacy-password", 4);
    await expect(comparePassword("legacy-password", legacy)).resolves.toBe(true);

    const pooled = await hashPassword("pooled-password", 4);
    expect(pooled).toMatch(/^\$2[ab]\$04\$/);
    await expect(bcrypt.compare("pooled-password", pooled)).resolves.toBe(true);
  });

  it("keeps the requested cost factor (never silently weakened)", async () => {
    const hash = await hashPassword("x", 5);
    expect(hash.startsWith("$2a$05$") || hash.startsWith("$2b$05$")).toBe(true);
  });

  it("handles many concurrent operations with correct, independent results", async () => {
    const hashes = await Promise.all(Array.from({ length: 12 }, (_, i) => hashPassword(`pw-${i}`, 4)));
    const checks = await Promise.all(hashes.map((h, i) => comparePassword(`pw-${i}`, h)));
    const crossChecks = await Promise.all(hashes.map((h, i) => comparePassword(`pw-${(i + 1) % 12}`, h)));
    expect(checks.every(Boolean)).toBe(true);
    expect(crossChecks.some(Boolean)).toBe(false);
  });

  it("resolves false (never true) for a malformed hash", async () => {
    await expect(comparePassword("x", "not-a-bcrypt-hash")).resolves.toBe(false);
  });
});
