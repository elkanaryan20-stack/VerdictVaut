import { NetworkEnvironment } from "@prisma/client";

/**
 * The SINGLE source of truth mapping the process-level APP_ENVIRONMENT
 * config value onto the NetworkEnvironment a provider configuration
 * (CustodyProviderConfig/ComplianceProviderConfig) MUST be flagged as
 * before this running process may use it for a real provider call.
 *
 * Every real-provider-execution/verification path —
 * WithdrawalExecutorFactory, FireblocksCustodyAdapter (independently,
 * defense-in-depth), and FireblocksWebhookController — calls this ONE
 * function rather than each repeating its own "appEnvironment === ..."
 * comparison. Centralizing it means a future third environment value
 * (or a typo in one call site) can't silently create an inconsistency
 * between two checks that are each individually "correct" but disagree
 * with each other — the exact class of bug that let a non-production
 * process use a PRODUCTION-flagged Fireblocks config (Phase 14B
 * security review finding A1).
 *
 * Only the literal string "production" ever requires a PRODUCTION-
 * flagged provider config. Every other value — "sandbox", "staging", an
 * unrecognized/misconfigured value, anything else — requires SANDBOX.
 * This matches this codebase's existing "anything that is not literally
 * production is treated as the safe/non-production case" convention
 * (see WithdrawalExecutorFactory's own pre-existing production check),
 * and means a typo'd or novel APP_ENVIRONMENT value fails closed to the
 * MORE restrictive requirement (never allowed to use a PRODUCTION
 * config) rather than the more permissive one.
 */
export function requiredProviderConfigEnvironment(appEnvironment: string): NetworkEnvironment {
  return appEnvironment === "production" ? NetworkEnvironment.PRODUCTION : NetworkEnvironment.SANDBOX;
}

/**
 * Throws if `providerConfigEnvironment` does not match what this
 * process's `appEnvironment` requires — the shared guard every call
 * site should apply immediately before resolving credentials/making a
 * real provider request. `describeProviderConfig` should name the
 * specific config row (e.g. "CustodyProviderConfig cfg-123") so the
 * resulting error is directly actionable.
 */
export function assertProviderConfigEnvironmentMatches(providerConfigEnvironment: NetworkEnvironment, appEnvironment: string, describeProviderConfig: string): void {
  const required = requiredProviderConfigEnvironment(appEnvironment);
  if (providerConfigEnvironment !== required) {
    throw new Error(
      `${describeProviderConfig} is flagged ${providerConfigEnvironment}, but the running application environment ("${appEnvironment}") requires ${required} — ` +
        "refusing to use a provider configuration from a different environment.",
    );
  }
}
