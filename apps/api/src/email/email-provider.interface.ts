/**
 * Narrow, provider-neutral email-sending seam (Phase 20) — deliberately
 * scoped to exactly one use case (the account-verification email), not
 * a general notification/messaging framework. If a genuinely different
 * kind of email is ever needed (password-reset, security alerts, ...),
 * that is a new, separate decision, not something this interface should
 * grow ad hoc methods for.
 *
 * Mirrors this codebase's existing provider-abstraction shape
 * (WithdrawalExecutor, WithdrawalComplianceGate): application code
 * (AuthService) depends on this interface only, never on Postmark
 * directly, so swapping providers later means implementing this
 * interface and changing EmailModule's binding — nothing else changes.
 */
export const EMAIL_PROVIDER = Symbol("EMAIL_PROVIDER");

export interface SendVerificationEmailInput {
  to: string;
  verificationUrl: string;
}

/**
 * `providerMessageId` is populated ONLY when the underlying provider's
 * API actually returned one in its response (see PostmarkEmailProvider's
 * own docblock) — never fabricated, never a placeholder string. A
 * successful `send()` proves the provider ACCEPTED the message for
 * delivery, not that it was actually delivered, opened, or clicked —
 * this interface has no notion of eventual delivery/bounce/complaint
 * state, matching how far this phase's scope actually reaches (see
 * docs/email-delivery.md's failure-semantics section).
 */
export interface SendVerificationEmailResult {
  providerMessageId: string;
}

export interface EmailProvider {
  sendVerificationEmail(input: SendVerificationEmailInput): Promise<SendVerificationEmailResult>;
}
