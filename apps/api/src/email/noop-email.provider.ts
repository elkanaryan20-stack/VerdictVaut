import { Injectable, Logger } from "@nestjs/common";
import * as crypto from "crypto";
import { EmailProvider, SendVerificationEmailInput, SendVerificationEmailResult } from "./email-provider.interface";

/**
 * Selected whenever EMAIL_PROVIDER is not "postmark" — local
 * development, CI, and every automated test run. Makes NO network call
 * of any kind (no `fetch`, no DNS lookup) — the only way to prove no
 * real email is ever sent from this path.
 *
 * Mirrors DeferredComplianceGate's own precedent: a safe, honestly-named
 * placeholder that never claims a real outcome it didn't perform. The
 * returned `providerMessageId` is locally generated and clearly not a
 * real provider identifier — nothing downstream should ever treat it as
 * proof of delivery (nothing does; AuthService never returns this value
 * to an HTTP caller — see its own docblock).
 */
@Injectable()
export class NoopEmailProvider implements EmailProvider {
  private readonly logger = new Logger(NoopEmailProvider.name);

  async sendVerificationEmail(input: SendVerificationEmailInput): Promise<SendVerificationEmailResult> {
    // Never logs input.verificationUrl (it embeds the single-use token)
    // — only the recipient address, which is not sensitive here (the
    // same address every other auth log line already includes on a
    // failed-login attempt).
    this.logger.log({ event: "verification_email.noop_skipped", to: input.to });
    return { providerMessageId: `noop-${crypto.randomUUID()}` };
  }
}
