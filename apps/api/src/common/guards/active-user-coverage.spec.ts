import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ACTIVE_USER_KEY } from "../decorators/require-active-user.decorator";
import { ActiveUserGuard } from "./active-user.guard";
import { TradingController } from "../../trading/trading.controller";
import { DepositsController } from "../../wallet/deposits/deposits.controller";
import { WithdrawalsController } from "../../wallet/withdrawals/withdrawals.controller";

/**
 * Phase 30 — a regression test for the ACTIVE_USER_GATE boundary itself
 * (`ActiveUserGuard`'s own docblock names exactly these 3 routes as the
 * ones Phase 20's security-gate remediation added it to, and exactly
 * which sibling routes were deliberately left ungated and why). Same
 * motivation as admin.controller.authorization.spec.ts (Phase 17): the
 * guard's own unit test (active-user.guard.spec.ts) only proves its
 * LOGIC is correct against a mocked ExecutionContext — nothing
 * previously asserted, against the REAL controller classes, that the
 * guard is actually wired onto the specific routes that need it.
 *
 * Unlike the admin audit, this can't be a fully dynamic "every non-GET
 * route must have X" scan — ActiveUserGuard is deliberately NOT applied
 * to every financial mutation (order cancel, withdrawal cancel,
 * retry-matching are intentionally exempt, per each route's own
 * comment: they only ever reduce existing exposure, never create new
 * exposure for a non-ACTIVE account). So this is a curated allowlist/
 * denylist instead — it will not catch every possible future gap the
 * way the admin audit's dynamic scan does, but it does lock in exactly
 * the boundary Phase 20 established and prevents a silent regression on
 * these 3 specific routes (e.g. someone removing @UseGuards(ActiveUserGuard)
 * while leaving @RequireActiveUser() behind, which would silently make
 * the metadata a no-op — checked here, not just the metadata alone).
 */
// eslint-disable-next-line @typescript-eslint/ban-types
function hasActiveUserGuardWired(handler: Function): boolean {
  const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
  const requiresActive = Reflect.getMetadata(ACTIVE_USER_KEY, handler) === true;
  return requiresActive && guards.includes(ActiveUserGuard);
}

describe("ActiveUserGuard coverage — the 3 routes Phase 20 gated", () => {
  it("TradingController.createOrder requires an ACTIVE user", () => {
    expect(hasActiveUserGuardWired(TradingController.prototype.createOrder)).toBe(true);
  });

  it("DepositsController.assignAddress requires an ACTIVE user", () => {
    expect(hasActiveUserGuardWired(DepositsController.prototype.assignAddress)).toBe(true);
  });

  it("WithdrawalsController.request requires an ACTIVE user", () => {
    expect(hasActiveUserGuardWired(WithdrawalsController.prototype.request)).toBe(true);
  });
});

describe("ActiveUserGuard deliberate exemptions — reduces exposure only, never creates it", () => {
  it("TradingController.retryMatching is NOT gated (resumes an existing, already-ACTIVE-at-creation order)", () => {
    expect(hasActiveUserGuardWired(TradingController.prototype.retryMatching)).toBe(false);
  });

  it("TradingController.cancelOrder is NOT gated (cancellation only reduces exposure)", () => {
    expect(hasActiveUserGuardWired(TradingController.prototype.cancelOrder)).toBe(false);
  });

  it("WithdrawalsController.cancel is NOT gated (cancellation only reduces exposure)", () => {
    expect(hasActiveUserGuardWired(WithdrawalsController.prototype.cancel)).toBe(false);
  });
});
