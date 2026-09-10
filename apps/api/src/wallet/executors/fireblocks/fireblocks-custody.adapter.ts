import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfig } from "../../../config/configuration";
import { PrismaService } from "../../../prisma/prisma.service";
import { SecretResolverService } from "../../provider-config/secret-resolver.service";
import { requiredProviderConfigEnvironment } from "../../provider-config/provider-environment.util";
import { LoggingMetricsService, MetricsService } from "../../../observability/metrics.service";
import { WithdrawalExecutionRequest, WithdrawalExecutionResult, WithdrawalExecutor, WithdrawalExecutorStatusLookup } from "../withdrawal-executor.interface";
import { withRetry } from "../../chain-adapters/retry.util";
import { fireblocksRequest, FireblocksApiError, FireblocksHttpConfig, FireblocksMalformedResponseError, FireblocksTransportError } from "./fireblocks-http.util";
import { mapFireblocksResponseToExecutionResult, mapFireblocksResponseToStatusLookup } from "./fireblocks-status.mapper";

interface FireblocksTransactionResponse {
  id: string;
  status: string;
  txHash?: string;
}

/**
 * Real Fireblocks REST integration, SANDBOX ONLY (see
 * WithdrawalExecutorFactory — this class is never selected in
 * production; ProductionCustodyExecutor remains the unconditionally-
 * throwing placeholder there, unchanged). Every fact this adapter's
 * request shape relies on is one of:
 *
 *   VERIFIED (Phase 14B primary-source research):
 *   - Auth: X-API-Key header + Authorization: Bearer <RS256 JWT>,
 *     claims {uri, nonce, iat, exp, sub, bodyHash} — see
 *     fireblocks-jwt.util.ts.
 *   - Idempotency: request-body field `externalTxId` — "additional
 *     transaction requests with the same externalTxId value are not
 *     processed" (developers.fireblocks.com/reference/createtransaction).
 *   - Request field NAMES: assetId, amount, source, destination, note,
 *     externalTxId.
 *   - The full transaction status enum (fireblocks-status.mapper.ts).
 *
 *   HIGH-CONFIDENCE BUT NOT LITERALLY RE-RENDERED THIS PASS:
 *   - The exact path "/transactions" (inferred from the reference page's
 *     own slug/operation id "createTransaction", not seen as a literal
 *     example).
 *   - `source.type: "VAULT_ACCOUNT"` / `destination.type:
 *     "ONE_TIME_ADDRESS"` — Fireblocks' well-known account model
 *     terminology, not independently re-confirmed as literal enum
 *     strings in this research pass.
 *   These MUST be smoke-tested against a real Fireblocks sandbox
 *   account before this adapter is trusted operationally — see
 *   docs/provider-integration.md.
 *
 *   EXPLICITLY UNVERIFIED — FAILS CLOSED, NEVER GUESSED:
 *   - Per-asset `assetId` strings (not even confirmed for XRP) — see
 *     supportsAssetNetwork()/WithdrawalExecutionConfig.providerAssetId.
 *   - The destination-tag/memo field shape for THIS specific endpoint
 *     (the verified "address:tag" convention was documented for
 *     vault/whitelist addresses, not confirmed for transaction
 *     creation specifically) — see execute()'s explicit refusal below.
 */
@Injectable()
export class FireblocksCustodyAdapter implements WithdrawalExecutor {
  private readonly logger = new Logger(FireblocksCustodyAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secretResolver: SecretResolverService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly metrics: MetricsService = new LoggingMetricsService(),
  ) {}

  async supportsAssetNetwork(assetNetworkId: string): Promise<boolean> {
    const config = await this.prisma.withdrawalExecutionConfig.findUnique({ where: { assetNetworkId } });
    // Fail closed: no verified provider asset id means this adapter
    // must not be used for this asset/network, regardless of anything
    // else being configured — see providerAssetId's own schema docblock.
    return Boolean(config?.providerAssetId);
  }

  async execute(request: WithdrawalExecutionRequest): Promise<WithdrawalExecutionResult> {
    const started = Date.now();
    const tags = { provider: "fireblocks", assetNetworkId: request.assetNetworkId };
    this.metrics.increment("provider_requests_total", { ...tags, operation: "execute" });

    if (request.destinationTag) {
      // Explicitly unverified capability — see class docblock. Failing
      // here (before any network call) rather than guessing a
      // destination-tag request shape.
      this.metrics.increment("provider_request_failures_total", { ...tags, operation: "execute", errorClass: "unverified_destination_tag" });
      throw new Error(
        "FireblocksCustodyAdapter cannot execute a withdrawal with a destination tag/memo — the exact request shape for " +
          "tag-bearing destinations (e.g. XRP) was not verified from primary Fireblocks documentation and is not guessed. " +
          "Configure a different executor for this asset/network until verified.",
      );
    }

    const executionConfig = await this.prisma.withdrawalExecutionConfig.findUnique({ where: { assetNetworkId: request.assetNetworkId } });
    if (!executionConfig?.providerAssetId) {
      throw new Error(`No verified Fireblocks providerAssetId is configured for asset/network ${request.assetNetworkId} — refusing to guess one.`);
    }

    const httpConfig = await this.resolveHttpConfig(executionConfig.custodyProviderConfigId);
    const vaultAccountId = await this.resolveVaultAccountId(executionConfig.custodyProviderConfigId);

    const body = {
      assetId: executionConfig.providerAssetId,
      amount: request.amount,
      source: { type: "VAULT_ACCOUNT", id: vaultAccountId },
      destination: { type: "ONE_TIME_ADDRESS", oneTimeAddress: { address: request.destinationAddress } },
      externalTxId: request.idempotencyKey,
      note: `VerdictVaut withdrawal ${request.withdrawalId}`,
    };

    let response: FireblocksTransactionResponse;
    try {
      // Deliberately NOT retried automatically (Phase 14B section 3: "do
      // not retry an ambiguous submission blindly") — a transport
      // failure here is caught below and reported as ambiguous rather
      // than silently resubmitted, even though Fireblocks' own
      // externalTxId de-duplication would likely make a resubmission
      // safe; an explicit SUPER_ADMIN/checkStatus()-mediated resolution
      // is preferred over an implicit retry for a real money movement.
      response = await fireblocksRequest<FireblocksTransactionResponse>(httpConfig, "POST", "/transactions", body);
    } catch (error) {
      this.metrics.increment("provider_request_failures_total", { ...tags, operation: "execute", errorClass: this.classifyError(error) });
      this.metrics.timing("provider_request_latency", Date.now() - started, { ...tags, operation: "execute" });
      return this.handleExecuteFailure(error);
    }

    this.metrics.timing("provider_request_latency", Date.now() - started, { ...tags, operation: "execute" });
    const result = mapFireblocksResponseToExecutionResult({ id: response.id, status: response.status, txHash: response.txHash });
    if (result.status === "ambiguous") {
      this.metrics.increment("provider_ambiguous_operations_total", tags);
    }
    return result;
  }

  async checkStatus(idempotencyKey: string): Promise<WithdrawalExecutorStatusLookup> {
    const withdrawal = await this.prisma.withdrawal.findUnique({ where: { id: idempotencyKey } });
    if (!withdrawal?.custodyReference) {
      // We never received a Fireblocks id for this withdrawal — the
      // original request may never have reached Fireblocks at all.
      // Fireblocks' filter-by-externalTxId capability was not verified
      // in this research pass, so this is NOT resolved by guessing at
      // such an endpoint — genuine manual verification is required.
      return { status: "not_found", reason: "No providerReference was ever recorded for this withdrawal — verify directly via the Fireblocks dashboard/API using its own tooling." };
    }

    const executionConfig = await this.prisma.withdrawalExecutionConfig.findUnique({ where: { assetNetworkId: withdrawal.assetNetworkId } });
    const httpConfig = await this.resolveHttpConfig(executionConfig?.custodyProviderConfigId ?? null);

    try {
      // Read-only lookup — safe to retry on transient failure, unlike execute().
      const response = await withRetry(() => fireblocksRequest<FireblocksTransactionResponse>(httpConfig, "GET", `/transactions/${withdrawal.custodyReference}`), { maxAttempts: 3 });
      return mapFireblocksResponseToStatusLookup({ id: response.id, status: response.status, txHash: response.txHash });
    } catch (error) {
      // A 404 on a direct GET-by-id call is standard REST semantics
      // (distinct from the UNVERIFIED "filter/search by externalTxId"
      // capability referenced above) — genuinely means Fireblocks has no
      // record of this id, worth surfacing as "not_found" rather than
      // letting a caller (e.g. reconciliation) treat it as a transient
      // lookup failure.
      if (error instanceof FireblocksApiError && error.status === 404) {
        return { status: "not_found", reason: `Fireblocks has no record of transaction ${withdrawal.custodyReference}.` };
      }
      throw error;
    }
  }

  private handleExecuteFailure(error: unknown): WithdrawalExecutionResult {
    if (error instanceof FireblocksTransportError) {
      // Timeout/network error — genuinely unknown whether Fireblocks
      // received the request before the connection dropped.
      return { status: "ambiguous", reason: error.message };
    }
    if (error instanceof FireblocksApiError) {
      if (error.status === 401 || error.status === 403) {
        throw new Error(`Fireblocks authentication failed (HTTP ${error.status}) — the request was rejected before any transaction was created.`);
      }
      if (error.status === 429) {
        throw new Error("Fireblocks rate-limited this request (HTTP 429) — no transaction was created.");
      }
      if (error.status >= 400 && error.status < 500) {
        throw new Error(`Fireblocks rejected the request as invalid (HTTP ${error.status}) — no transaction was created.`);
      }
      // 5xx: genuinely unclear whether the request was processed before
      // the server-side failure occurred.
      return { status: "ambiguous", reason: `Fireblocks returned a server error (HTTP ${error.status}).` };
    }
    if (error instanceof FireblocksMalformedResponseError) {
      // We got SOME response (a success-range status, even) that we
      // could not parse — genuinely unclear what it meant.
      return { status: "ambiguous", reason: error.message };
    }
    throw error;
  }

  private classifyError(error: unknown): string {
    if (error instanceof FireblocksTransportError) return "transport";
    if (error instanceof FireblocksApiError) return `http_${error.status}`;
    if (error instanceof FireblocksMalformedResponseError) return "malformed_response";
    return "unknown";
  }

  private async resolveHttpConfig(custodyProviderConfigId: string | null | undefined): Promise<FireblocksHttpConfig> {
    if (!custodyProviderConfigId) {
      throw new Error("No CustodyProviderConfig is linked for this withdrawal's asset/network.");
    }
    const providerConfig = await this.prisma.custodyProviderConfig.findUnique({ where: { id: custodyProviderConfigId } });
    if (!providerConfig?.apiBaseUrl || !providerConfig.credentialsSecretRef) {
      throw new Error("CustodyProviderConfig is missing apiBaseUrl or credentialsSecretRef — cannot call Fireblocks.");
    }
    // Security review finding A1 — a SECOND, independent check of the
    // exact same fact WithdrawalExecutorFactory already verified before
    // ever selecting this adapter. Deliberately re-checked here (not
    // trusted from the caller) so that even a future caller who
    // constructs/calls this adapter directly, bypassing the factory,
    // still cannot make a real request using a provider configuration
    // flagged for a different runtime environment (e.g. a PRODUCTION
    // Fireblocks config used from a sandbox process).
    const appEnvironment = this.config.get("appEnvironment", { infer: true });
    const requiredEnvironment = requiredProviderConfigEnvironment(appEnvironment);
    if (providerConfig.environment !== requiredEnvironment) {
      throw new Error(
        `CustodyProviderConfig ${providerConfig.id} is flagged ${providerConfig.environment}, but the running application environment ` +
          `("${appEnvironment}") requires ${requiredEnvironment} — refusing to use a provider configuration from a different environment.`,
      );
    }
    const credentialsJson = this.secretResolver.resolve(providerConfig.credentialsSecretRef);
    let credentials: { apiKey?: string; privateKey?: string };
    try {
      credentials = JSON.parse(credentialsJson);
    } catch {
      throw new Error(
        "The secret referenced by credentialsSecretRef did not parse as JSON — FireblocksCustodyAdapter expects " +
          '{"apiKey": "...", "privateKey": "-----BEGIN PRIVATE KEY-----..."}.',
      );
    }
    if (!credentials.apiKey || !credentials.privateKey) {
      throw new Error('Fireblocks credentials JSON is missing "apiKey" or "privateKey".');
    }
    return {
      apiBaseUrl: providerConfig.apiBaseUrl,
      apiKey: credentials.apiKey,
      privateKeyPem: credentials.privateKey,
      timeoutMs: providerConfig.timeoutMs,
    };
  }

  private async resolveVaultAccountId(custodyProviderConfigId: string | null | undefined): Promise<string> {
    if (!custodyProviderConfigId) {
      throw new Error("No CustodyProviderConfig is linked for this withdrawal's asset/network.");
    }
    const providerConfig = await this.prisma.custodyProviderConfig.findUnique({ where: { id: custodyProviderConfigId } });
    if (!providerConfig?.vaultOrAccountRef) {
      throw new Error("CustodyProviderConfig has no vaultOrAccountRef configured — required to select which Fireblocks vault account funds this withdrawal.");
    }
    return providerConfig.vaultOrAccountRef;
  }
}
