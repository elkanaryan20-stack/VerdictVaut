import "reflect-metadata";
import { METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../common/decorators/roles.decorator";
import { AdminController } from "./admin.controller";

/**
 * Phase 17 — a regression test for AdminController's authorization
 * BOUNDARY itself, not for RolesGuard's own logic (already covered by
 * roles.guard.spec.ts) or for any individual endpoint's business logic
 * (covered by the service-level specs). Nothing in this codebase
 * previously asserted, in an automated test, which @Roles(...) metadata
 * is actually attached to each of AdminController's real route
 * handlers — every existing test either mocks the guard away entirely
 * or calls a service method directly, bypassing the controller/guard
 * layer completely. This closes that gap directly against the real
 * `AdminController` class and the real `@nestjs/common` metadata Nest
 * itself routes on, using `reflect-metadata` (no HTTP server needed).
 *
 * Reads the HTTP-method metadata dynamically (not a hardcoded route
 * list) so a newly-added mutation endpoint is covered automatically —
 * this test would fail the moment someone adds a POST/PATCH/PUT/DELETE
 * handler to AdminController without an explicit method-level
 * @Roles(SUPER_ADMIN), which is this controller's own stated design
 * (see its class docblock: "an ordinary ADMIN must never be able to
 * reconfigure assets/networks, provision deposit addresses, run
 * reconciliation, reprocess a deposit, or move a withdrawal through
 * approval/broadcast").
 */
describe("AdminController — authorization decorator audit (Phase 17)", () => {
  it("the class-level baseline requires ADMIN or SUPER_ADMIN — never unauthenticated, never a plain USER", () => {
    const classRoles = Reflect.getMetadata(ROLES_KEY, AdminController);
    expect(classRoles).toEqual([UserRole.ADMIN, UserRole.SUPER_ADMIN]);
  });

  const prototype = AdminController.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const methodNames = Object.getOwnPropertyNames(prototype).filter(
    (name) => name !== "constructor" && typeof prototype[name] === "function",
  );

  const mutationHandlers = methodNames.filter((name) => {
    const httpMethod: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, prototype[name]);
    return httpMethod !== undefined && httpMethod !== RequestMethod.GET;
  });

  // Sanity check on the audit mechanism itself — if this ever drops to
  // 0 (e.g. a refactor changes how routes are declared, or the
  // decorator import path changes), every test below would trivially
  // "pass" by having nothing to check, silently stopping being a real
  // regression test. This fails loudly instead.
  it("found a real, non-empty set of mutation (non-GET) route handlers to audit", () => {
    expect(mutationHandlers.length).toBeGreaterThan(20);
  });

  for (const methodName of mutationHandlers) {
    it(`${methodName}() — a non-GET admin route — requires exactly SUPER_ADMIN, not just the class-level ADMIN/SUPER_ADMIN baseline`, () => {
      const methodRoles = Reflect.getMetadata(ROLES_KEY, prototype[methodName]);
      expect(methodRoles).toEqual([UserRole.SUPER_ADMIN]);
    });
  }

  // A handful of GET (read-only) routes are deliberately narrowed to
  // SUPER_ADMIN too, beyond the class default — named explicitly here
  // (unlike the dynamic loop above, since there's no "GET routes are
  // always X" rule to derive this from) because the data they expose
  // (provider capability/webhook internals, per-withdrawal compliance
  // signals) is materially more sensitive than ordinary operational
  // listings.
  const superAdminOnlyGetRoutes = [
    "getProviderCapabilityMatrix",
    "listProviderWebhookEvents",
    "getWithdrawalComplianceSignals",
  ];

  for (const methodName of superAdminOnlyGetRoutes) {
    it(`${methodName}() — a sensitive read-only route — is narrowed to SUPER_ADMIN, not left at the class-level ADMIN/SUPER_ADMIN default`, () => {
      const handler = prototype[methodName];
      expect(handler).toBeDefined();
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.SUPER_ADMIN]);
    });
  }

  // The inverse check for one representative ordinary read-only listing
  // — proves the dynamic loop above isn't vacuously passing because
  // EVERY method (GET included) happens to carry SUPER_ADMIN metadata.
  it("an ordinary read-only listing (listWatcherStatus) has NO method-level override — it relies on the class-level ADMIN/SUPER_ADMIN baseline", () => {
    expect(Reflect.getMetadata(ROLES_KEY, prototype.listWatcherStatus)).toBeUndefined();
  });
});
