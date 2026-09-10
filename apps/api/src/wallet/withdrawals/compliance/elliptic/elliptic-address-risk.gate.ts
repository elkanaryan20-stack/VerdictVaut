import { Injectable, Logger } from "@nestjs/common";
import { ComplianceProviderCategory, NetworkFamily, NetworkEnvironment, WithdrawalComplianceDecision } from "@prisma/client";
import { PrismaService } from "../../../../prisma/prisma.service";
import { SecretResolverService } from "../../../provider-config/secret-resolver.service";
import { LoggingMetricsService, MetricsService } from "../../../../observability/metrics.service";
import { WithdrawalComplianceAssessment, WithdrawalComplianceContext, WithdrawalComplianceGate } from "../withdrawal-compliance-gate.interface";
import { ellipticRequest, EllipticApiError, EllipticHttpConfig, EllipticMalformedResponseError, EllipticTransportError } from "./elliptic-http.util";
import { mapEllipticRiskScoreToAddressRiskStatus } from "./elliptic-risk.mapper";

interface EllipticWalletAnalysisSubmission {
  id: string;
  process_status: string;
}

interface EllipticWalletAnalysisResult {
  id: string;
  risk_score: number | null;
  process_status: "running" | "complete" | "error";
}

/**
 * Real Elliptic AML API address-risk screening — SANDBOX ONLY (never
 * wired into production; see ComplianceGateFactory). Screens ONLY the
 * withdrawal's destination address (crypto-AML "address risk"); it has
 * no bearing on KYC identity verification or sanctions-list screening
 * of the USER, which remain NOT_PERFORMED here — those are a different
 * provider concern (Elliptic's own docs describe transaction/wallet
 * screening, not identity KYC).
 *
 * Every fact this relies on is one of:
 *
 *   VERIFIED (Phase 14B primary-source research,
 *   https://developers.elliptic.co/docs/authentication and
 *   https://developers.elliptic.co/reference/post_wallet /
 *   .../get_wallet-wallet-analysis-id):
 *   - Auth: HMAC-SHA256 over `${timestampMs}${METHOD}${lowercasePath}${payload}`
 *     using headers x-access-key/x-access-sign/x-access-timestamp — see
 *     elliptic-auth.util.ts.
 *   - Base URL https://aml-api.elliptic.co/v2.
 *   - POST /wallet accepts a BATCH (array) of
 *     {subject: {asset, blockchain, type, hash}, type: "wallet_exposure"}
 *     and returns an array of {id, process_status, ...}.
 *   - GET /wallet/{id} returns {risk_score: number|null,
 *     process_status: "running"|"complete"|"error", ...}. risk_score is
 *     a raw float with NO documented categorical enum — see
 *     elliptic-risk.mapper.ts.
 *   - The {asset: "holistic", blockchain: "holistic", type: "address"}
 *     subject shape is confirmed for an EVM-style address (the
 *     documented example uses an Ethereum address).
 *
 *   EXPLICITLY UNVERIFIED — FAILS CLOSED, NEVER GUESSED:
 *   - The correct `asset`/`blockchain` identifiers for Bitcoin, Solana,
 *     or XRP ADDRESS screening specifically. (A `{"asset": "BTC", "type":
 *     "transaction", ...}` example exists, but for a *transaction*
 *     subject, not an *address* subject — a materially different
 *     request, not safe to reuse here.) See supportsAssetNetwork().
 *   - Whether POST /wallet is idempotent on repeated identical
 *     submissions (no idempotency-key mechanism is documented) — this
 *     gate therefore submits at most once per assess() call and never
 *     retries a submission automatically.
 *   - Analysis completion latency: wallet_exposure analyses are
 *     documented as asynchronous ("process_status": "running" is a real,
 *     expected initial state). This gate does NOT block the withdrawal
 *     request behind an invented polling/sleep loop — it makes exactly
 *     one immediate follow-up GET after submission, and honestly reports
 *     NOT_PERFORMED (never a fabricated LOW/CLEAR result) if the
 *     analysis has not completed by then. A later phase should resolve
 *     still-pending analyses asynchronously (mirroring
 *     WithdrawalWatcherService's provider-polling pattern) — tracked as
 *     a known limitation in docs/provider-integration.md.
 */
@Injectable()
export class EllipticAddressRiskGate implements WithdrawalComplianceGate {
  private readonly logger = new Logger(EllipticAddressRiskGate.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secretResolver: SecretResolverService,
    private readonly metrics: MetricsService = new LoggingMetricsService(),
  ) {}

  /** Only EVM networks have a VERIFIED address-screening request shape — see class docblock. */
  supportsNetworkFamily(networkFamily: NetworkFamily): boolean {
    return networkFamily === NetworkFamily.EVM;
  }

  async assess(context: WithdrawalComplianceContext): Promise<WithdrawalComplianceAssessment> {
    const tags = { provider: "elliptic", networkFamily: context.networkFamily };

    if (!this.supportsNetworkFamily(context.networkFamily)) {
      return {
        decision: WithdrawalComplianceDecision.DEFERRED,
        reason: "Elliptic address-risk screening has no verified request shape for this network family — pending mandatory human SUPER_ADMIN review.",
        signals: { kycStatus: "NOT_PERFORMED", sanctionsScreeningStatus: "NOT_PERFORMED", addressRiskScreeningStatus: "NOT_PERFORMED" },
      };
    }

    const providerConfig = await this.prisma.complianceProviderConfig.findFirst({
      where: { category: ComplianceProviderCategory.SANCTIONS_KYT, environment: NetworkEnvironment.SANDBOX, providerName: { equals: "Elliptic", mode: "insensitive" }, isEnabled: true },
    });
    if (!providerConfig?.apiBaseUrl || !providerConfig.credentialsSecretRef) {
      return {
        decision: WithdrawalComplianceDecision.DEFERRED,
        reason: "No enabled Elliptic ComplianceProviderConfig with apiBaseUrl/credentialsSecretRef is configured.",
        signals: { kycStatus: "NOT_PERFORMED", sanctionsScreeningStatus: "NOT_PERFORMED", addressRiskScreeningStatus: "NOT_PERFORMED" },
      };
    }

    this.metrics.increment("provider_requests_total", { ...tags, operation: "assess" });
    const started = Date.now();
    try {
      const httpConfig = await this.resolveHttpConfig(providerConfig.apiBaseUrl, providerConfig.credentialsSecretRef, providerConfig.timeoutMs);
      const [submission] = await ellipticRequest<EllipticWalletAnalysisSubmission[]>(httpConfig, "POST", "/wallet", [
        { subject: { asset: "holistic", blockchain: "holistic", type: "address", hash: context.destinationAddress }, type: "wallet_exposure" },
      ]);

      // Exactly one immediate follow-up read — never a polling/sleep
      // loop invented for this pass. See class docblock.
      const result = await ellipticRequest<EllipticWalletAnalysisResult>(httpConfig, "GET", `/wallet/${submission.id}`);
      this.metrics.timing("provider_request_latency", Date.now() - started, { ...tags, operation: "assess" });

      const riskScore = result.process_status === "complete" ? result.risk_score : null;
      const addressRiskScreeningStatus = mapEllipticRiskScoreToAddressRiskStatus(riskScore, {
        mediumThreshold: providerConfig.riskScoreMediumThreshold,
        highThreshold: providerConfig.riskScoreHighThreshold,
      });

      const signals = { kycStatus: "NOT_PERFORMED" as const, sanctionsScreeningStatus: "NOT_PERFORMED" as const, addressRiskScreeningStatus, providerReference: submission.id };

      if (addressRiskScreeningStatus === "HIGH" || addressRiskScreeningStatus === "BLOCKED") {
        return { decision: WithdrawalComplianceDecision.BLOCKED, reason: `Elliptic reported ${addressRiskScreeningStatus} address risk for the destination (analysis ${submission.id}).`, signals };
      }
      return {
        decision: WithdrawalComplianceDecision.DEFERRED,
        reason: `Elliptic address-risk screening: ${addressRiskScreeningStatus} (analysis ${submission.id}) — pending mandatory human SUPER_ADMIN review.`,
        signals,
      };
    } catch (error) {
      this.metrics.increment("provider_request_failures_total", { ...tags, operation: "assess", errorClass: this.classifyError(error) });
      this.logger.error(`Elliptic address-risk screening failed for withdrawal destination: ${(error as Error).message}`, error as Error);
      // A provider failure NEVER silently becomes a pass — reported as
      // ERROR and deferred to the human reviewer, same principle as
      // DeferredComplianceGate.
      return {
        decision: WithdrawalComplianceDecision.DEFERRED,
        reason: `Elliptic address-risk screening failed (${this.classifyError(error)}) — pending mandatory human SUPER_ADMIN review.`,
        signals: { kycStatus: "NOT_PERFORMED", sanctionsScreeningStatus: "NOT_PERFORMED", addressRiskScreeningStatus: "ERROR" },
      };
    }
  }

  private classifyError(error: unknown): string {
    if (error instanceof EllipticTransportError) return "transport";
    if (error instanceof EllipticApiError) return `http_${error.status}`;
    if (error instanceof EllipticMalformedResponseError) return "malformed_response";
    return "unknown";
  }

  private async resolveHttpConfig(apiBaseUrl: string, credentialsSecretRef: string, timeoutMs: number): Promise<EllipticHttpConfig> {
    const credentialsJson = this.secretResolver.resolve(credentialsSecretRef);
    let credentials: { apiKey?: string; apiSecret?: string };
    try {
      credentials = JSON.parse(credentialsJson);
    } catch {
      throw new Error('The secret referenced by credentialsSecretRef did not parse as JSON — EllipticAddressRiskGate expects {"apiKey": "...", "apiSecret": "<base64>"}.');
    }
    if (!credentials.apiKey || !credentials.apiSecret) {
      throw new Error('Elliptic credentials JSON is missing "apiKey" or "apiSecret".');
    }
    return { apiBaseUrl, apiKey: credentials.apiKey, apiSecretBase64: credentials.apiSecret, timeoutMs };
  }
}
