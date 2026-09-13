import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../config/configuration";
import { MetricsService } from "../observability/metrics.service";
import { EmailProvider } from "./email-provider.interface";
import { NoopEmailProvider } from "./noop-email.provider";
import { PostmarkEmailProvider } from "./postmark-email.provider";

/**
 * Selects the bound EmailProvider ONCE at application bootstrap, purely
 * from static config (EMAIL_PROVIDER) — unlike ComplianceGateFactory/
 * WithdrawalExecutorFactory, which re-check a DB row on every call
 * because custody/compliance provider selection is deliberately
 * runtime-toggleable without a redeploy. Email has no such requirement
 * (this phase explicitly does not add a database-driven provider
 * configuration system — see docs/email-delivery.md), so a plain
 * `useFactory` binding, decided once, is the simpler correct shape.
 *
 * Deliberately NEVER inspects `appEnvironment` here — production's
 * guarantee that NoopEmailProvider can't be silently selected already
 * lives in env.validation.ts's `assertProductionEmailConfigured` (which
 * refuses to let the process boot at all), so this factory only needs
 * to answer one question: does EMAIL_PROVIDER say "postmark", or not.
 */
export function emailProviderFactory(config: ConfigService<AppConfig, true>, metrics: MetricsService): EmailProvider {
  const email = config.get("email", { infer: true });
  if (email.provider === "postmark") {
    return new PostmarkEmailProvider({ serverToken: email.postmarkServerToken, fromAddress: email.fromAddress }, metrics);
  }
  return new NoopEmailProvider();
}
