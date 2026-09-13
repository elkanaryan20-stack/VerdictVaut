import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { THROTTLER_LIMIT, THROTTLER_TTL } from "@nestjs/throttler/dist/throttler.constants";
import { AuthController } from "./auth.controller";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";

/**
 * Phase 20 — a narrow decorator-audit regression test (same technique as
 * admin.controller.authorization.spec.ts, Phase 17) specifically for
 * resendVerificationEmail: proves, against the real controller class via
 * real reflect-metadata (no HTTP server needed), that it actually
 * carries JwtAuthGuard and the same AUTH_THROTTLE tier as every other
 * credential-adjacent endpoint on this controller — not just that the
 * source code looks right.
 */
describe("AuthController — resendVerificationEmail decorator audit (Phase 20)", () => {
  const handler = AuthController.prototype.resendVerificationEmail;

  it("requires authentication (JwtAuthGuard)", () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
    expect(guards).toContain(JwtAuthGuard);
  });

  it("is throttled at the same tier as register/login/verify-email (10/60s)", () => {
    const limit = Reflect.getMetadata(THROTTLER_LIMIT + "default", handler);
    const ttl = Reflect.getMetadata(THROTTLER_TTL + "default", handler);
    expect(limit).toBe(10);
    expect(ttl).toBe(60_000);
  });
});
