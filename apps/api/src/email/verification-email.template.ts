export interface VerificationEmailContent {
  subject: string;
  htmlBody: string;
  textBody: string;
}

/**
 * The ONLY dynamic value interpolated into this template is
 * `verificationUrl` — never the recipient's raw email address or any
 * other user-supplied string. `verificationUrl` is always server-
 * constructed (EMAIL_BASE_URL, an operator-controlled env var, plus a
 * crypto.randomBytes(32).toString("hex") token — pure `[0-9a-f]{64}`,
 * no characters that could break out of an HTML attribute), so no
 * escaping function is needed for it to be safe — but it is still
 * assembled through a single `escapeHtml` pass here anyway, as
 * defense-in-depth against a future change to what feeds this template
 * (e.g. a different token encoding), not because today's input is
 * unsafe.
 *
 * No financial/transaction language anywhere in this copy — this is an
 * account-verification email, not a statement of any balance, trade, or
 * transfer.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function renderVerificationEmail(input: { verificationUrl: string }): VerificationEmailContent {
  const safeUrl = escapeHtml(input.verificationUrl);
  const subject = "Verify your VerdictVaut account";

  const htmlBody = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; max-width: 480px; margin: 0 auto; padding: 24px;">
    <h1 style="font-size: 18px; margin-bottom: 16px;">Verify your VerdictVaut account</h1>
    <p style="font-size: 14px; line-height: 1.5;">
      You (or someone using this email address) recently registered a VerdictVaut account.
      To finish setting up your account, confirm this email address by clicking the button below.
    </p>
    <p style="margin: 24px 0;">
      <a href="${safeUrl}" style="background: #1a1a1a; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 6px; font-size: 14px; display: inline-block;">
        Verify email address
      </a>
    </p>
    <p style="font-size: 13px; color: #555555; line-height: 1.5;">
      This link expires in 24 hours and can only be used once. If it expires, you can request a new
      one from your account.
    </p>
    <p style="font-size: 13px; color: #555555; line-height: 1.5;">
      If you did not create a VerdictVaut account, you can safely ignore this email — no account
      access will be granted without completing this step.
    </p>
  </body>
</html>`;

  const textBody = [
    "Verify your VerdictVaut account",
    "",
    "You (or someone using this email address) recently registered a VerdictVaut account.",
    "To finish setting up your account, open the link below to confirm this email address:",
    "",
    input.verificationUrl,
    "",
    "This link expires in 24 hours and can only be used once. If it expires, you can request a new one from your account.",
    "",
    "If you did not create a VerdictVaut account, you can safely ignore this email — no account access will be granted without completing this step.",
  ].join("\n");

  return { subject, htmlBody, textBody };
}
