/**
 * Shared, named @Throttle policies for endpoints beyond the global
 * default (100 req/min/client — see app.module.ts) that specifically
 * move money or trigger a privileged/financial operation. Named and
 * centralized here (rather than a magic-number literal per controller)
 * so every sensitive endpoint's limit is visible and tunable in one
 * place — see requirement #13 (rate limiting / abuse protection).
 *
 * These are deliberately generous where legitimate high-frequency use is
 * expected (active trading) and tight where it isn't (admin/platform
 * actions, which are rare and high-stakes) — never a single blanket
 * number applied everywhere regardless of what the endpoint does.
 */
type ThrottleConfig = Record<string, { limit: number; ttl: number }>;

/** Order submission/cancellation/retry — generous enough that an active trader is never throttled during normal use, still bounded against a flooding script. */
export const TRADING_THROTTLE: ThrottleConfig = { default: { limit: 120, ttl: 60_000 } };

/** A user-facing withdrawal REQUEST (earmarks funds, creates admin review work) — legitimate users rarely submit many in a short window. */
export const WITHDRAWAL_REQUEST_THROTTLE: ThrottleConfig = { default: { limit: 10, ttl: 60_000 } };

/** SUPER_ADMIN-only platform-control mutations (asset/network config, address provisioning, withdrawal approve/reject/broadcast, reconciliation run, deposit reprocess, market resolve/retry-settlement) — rare, high-stakes, single-operator actions; a tight limit adds defense-in-depth without ever hampering legitimate one-shot admin use. */
export const ADMIN_MUTATION_THROTTLE: ThrottleConfig = { default: { limit: 30, ttl: 60_000 } };
