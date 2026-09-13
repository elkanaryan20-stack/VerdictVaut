import { Injectable, Logger } from "@nestjs/common";
import { LoggingMetricsService, MetricsService } from "../observability/metrics.service";
import { EmailProvider, SendVerificationEmailInput, SendVerificationEmailResult } from "./email-provider.interface";
import { PostmarkApiError, PostmarkMalformedResponseError, postmarkRequest, PostmarkTransportError } from "./postmark-http.util";
import { renderVerificationEmail } from "./verification-email.template";

// No documented request-level timeout guidance was found for Postmark's
// send endpoint — 10s matches this codebase's existing convention for a
// synchronous provider call (CustodyProviderConfig.timeoutMs's own
// default, ComplianceProviderConfig's own default).
const POSTMARK_REQUEST_TIMEOUT_MS = 10_000;

interface PostmarkSendResponse {
  MessageID: string;
  ErrorCode: number;
  Message: string;
}

export interface PostmarkEmailProviderConfig {
  serverToken: string;
  fromAddress: string;
}

/**
 * Real Postmark integration for exactly one email: the account
 * verification email. See postmark-http.util.ts's own docblock for the
 * VERIFIED request/response shape this relies on.
 *
 * Never logs `config.serverToken` (the credential) or the raw
 * verification URL/token (the input.verificationUrl string embeds the
 * single-use token as a query parameter) — every log/error path below
 * only ever includes the recipient address, the provider name, and a
 * classified error type, never the request or response body verbatim.
 */
@Injectable()
export class PostmarkEmailProvider implements EmailProvider {
  private readonly logger = new Logger(PostmarkEmailProvider.name);

  constructor(
    private readonly config: PostmarkEmailProviderConfig,
    private readonly metrics: MetricsService = new LoggingMetricsService(),
  ) {}

  async sendVerificationEmail(input: SendVerificationEmailInput): Promise<SendVerificationEmailResult> {
    const tags = { provider: "postmark", operation: "send_verification_email" };
    this.metrics.increment("email_provider_requests_total", tags);
    const started = Date.now();

    const { subject, htmlBody, textBody } = renderVerificationEmail({ verificationUrl: input.verificationUrl });

    try {
      const result = await postmarkRequest<PostmarkSendResponse>(
        { serverToken: this.config.serverToken, timeoutMs: POSTMARK_REQUEST_TIMEOUT_MS },
        {
          From: this.config.fromAddress,
          To: input.to,
          Subject: subject,
          HtmlBody: htmlBody,
          TextBody: textBody,
        },
      );
      this.metrics.timing("email_provider_request_latency", Date.now() - started, tags);
      // Deliberately no log line includes `result` itself — MessageID
      // alone is safe (it is Postmark's own opaque tracking id, not a
      // credential or the verification token), so it is the only field
      // read out of the response.
      this.logger.log({ event: "verification_email.provider_accepted", provider: "postmark" });
      return { providerMessageId: result.MessageID };
    } catch (error) {
      const errorClass = this.classifyError(error);
      this.metrics.increment("email_provider_request_failures_total", { ...tags, errorClass });
      this.logger.error(`Postmark verification-email send failed (${errorClass})`, (error as Error).stack ?? String(error));
      throw error;
    }
  }

  private classifyError(error: unknown): string {
    if (error instanceof PostmarkTransportError) return "transport";
    if (error instanceof PostmarkApiError) return `http_${error.status}`;
    if (error instanceof PostmarkMalformedResponseError) return "malformed_response";
    return "unknown";
  }
}
