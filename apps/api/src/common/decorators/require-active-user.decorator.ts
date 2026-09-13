import { SetMetadata } from "@nestjs/common";

/**
 * Phase 20 security-gate remediation — marks a route as requiring the
 * caller's account to be `UserStatus.ACTIVE` (i.e. genuinely email-
 * verified, or admin-activated), checked live against the database by
 * `ActiveUserGuard` on every request — never trusted from the JWT
 * payload, which never carries status at all (see JwtStrategy.validate,
 * which returns only {id, email, role}).
 *
 * Mirrors `@Roles(...)`/`ROLES_KEY`/`RolesGuard`'s exact shape (a plain
 * `SetMetadata` flag read via `Reflector.getAllAndOverride`) so this is
 * the same, single, declarative pattern already established in this
 * codebase for "some routes need an extra live DB check beyond bare
 * JWT identity" — not a new, separate mechanism.
 */
export const ACTIVE_USER_KEY = "requireActiveUser";
export const RequireActiveUser = () => SetMetadata(ACTIVE_USER_KEY, true);
