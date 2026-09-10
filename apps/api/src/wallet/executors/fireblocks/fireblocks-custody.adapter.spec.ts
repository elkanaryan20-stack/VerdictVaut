import * as crypto from "crypto";
import { PrismaService } from "../../../prisma/prisma.service";
import { SecretResolverService } from "../../provider-config/secret-resolver.service";
import { FireblocksCustodyAdapter } from "./fireblocks-custody.adapter";

function generateTestKeyPair() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).privateKey;
}

const testPrivateKey = generateTestKeyPair();
const validCredentialsJson = JSON.stringify({ apiKey: "test-api-key", privateKey: testPrivateKey });

describe("FireblocksCustodyAdapter", () => {
  let prisma: {
    withdrawalExecutionConfig: { findUnique: jest.Mock };
    custodyProviderConfig: { findUnique: jest.Mock };
    withdrawal: { findUnique: jest.Mock };
  };
  let secretResolver: { resolve: jest.Mock };
  let adapter: FireblocksCustodyAdapter;
  let fetchMock: jest.Mock;

  const providerConfig = {
    id: "cfg-1",
    apiBaseUrl: "https://sandbox-api.fireblocks.io/v1",
    credentialsSecretRef: "env:FIREBLOCKS_SANDBOX_CREDENTIALS",
    timeoutMs: 5000,
    vaultOrAccountRef: "0",
    environment: "SANDBOX",
  };
  const executionConfig = { assetNetworkId: "an-1", custodyProviderConfigId: "cfg-1", providerAssetId: "BTC_TEST" };

  let config: { get: jest.Mock };

  beforeEach(() => {
    prisma = {
      withdrawalExecutionConfig: { findUnique: jest.fn().mockResolvedValue(executionConfig) },
      custodyProviderConfig: { findUnique: jest.fn().mockResolvedValue(providerConfig) },
      withdrawal: { findUnique: jest.fn() },
    };
    secretResolver = { resolve: jest.fn().mockReturnValue(validCredentialsJson) };
    config = { get: jest.fn().mockReturnValue("sandbox") };
    adapter = new FireblocksCustodyAdapter(prisma as unknown as PrismaService, secretResolver as unknown as SecretResolverService, config as never);
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });

  describe("supportsAssetNetwork", () => {
    it("returns true only when a providerAssetId is configured", async () => {
      expect(await adapter.supportsAssetNetwork("an-1")).toBe(true);
    });

    it("returns false (fail closed) when no providerAssetId is configured, even if everything else exists", async () => {
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({ ...executionConfig, providerAssetId: null });
      expect(await adapter.supportsAssetNetwork("an-1")).toBe(false);
    });

    it("returns false when no execution config exists at all", async () => {
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue(null);
      expect(await adapter.supportsAssetNetwork("an-1")).toBe(false);
    });
  });

  describe("execute", () => {
    const baseRequest = { withdrawalId: "wd-1", assetNetworkId: "an-1", destinationAddress: "0xdest", amount: "0.01", idempotencyKey: "wd-1" };

    it("fails closed for a destination tag/memo — never guesses the unverified tag request shape", async () => {
      await expect(adapter.execute({ ...baseRequest, destinationTag: "12345" })).rejects.toThrow(/destination tag/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails closed when no providerAssetId is configured for this asset/network", async () => {
      prisma.withdrawalExecutionConfig.findUnique.mockResolvedValue({ ...executionConfig, providerAssetId: null });
      await expect(adapter.execute(baseRequest)).rejects.toThrow(/providerAssetId/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("submits a real request with externalTxId set to the idempotency key, and maps a SUBMITTED response to awaiting_manual_broadcast", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "fb-1", status: "SUBMITTED" }) });

      const result = await adapter.execute(baseRequest);

      expect(result).toEqual({ status: "awaiting_manual_broadcast", providerReference: "fb-1" });
      const [, options] = fetchMock.mock.calls[0];
      const sentBody = JSON.parse(options.body);
      expect(sentBody.externalTxId).toBe("wd-1");
      expect(sentBody.assetId).toBe("BTC_TEST");
    });

    it("maps a COMPLETED response with a txHash to a real broadcast result", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "fb-1", status: "COMPLETED", txHash: "0xreal" }) });
      const result = await adapter.execute(baseRequest);
      expect(result).toEqual({ status: "broadcast", txHash: "0xreal", providerReference: "fb-1" });
    });

    it("returns ambiguous (never throws, never retries automatically) on a network/timeout failure", async () => {
      fetchMock.mockRejectedValue(new Error("timeout"));
      const result = await adapter.execute(baseRequest);
      expect(result.status).toBe("ambiguous");
      expect(fetchMock).toHaveBeenCalledTimes(1); // no automatic retry
    });

    it("returns ambiguous on a 5xx response — genuinely unclear whether Fireblocks processed the request", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => "{}" });
      const result = await adapter.execute(baseRequest);
      expect(result.status).toBe("ambiguous");
    });

    it("throws (safe-to-retry, never ambiguous) on a 401 authentication failure — the request definitely never executed", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "{}" });
      await expect(adapter.execute(baseRequest)).rejects.toThrow(/authentication failed/);
    });

    it("throws on a 429 rate limit — the request definitely never executed", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "{}" });
      await expect(adapter.execute(baseRequest)).rejects.toThrow(/rate-limited/);
    });

    it("throws on a 400 validation error — the request definitely never executed", async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "{}" });
      await expect(adapter.execute(baseRequest)).rejects.toThrow(/rejected the request/);
    });

    it("returns ambiguous on a malformed (non-JSON) response", async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "not json" });
      const result = await adapter.execute(baseRequest);
      expect(result.status).toBe("ambiguous");
    });

    it("throws a clear error, never fabricating a submission, when the credentials JSON is malformed", async () => {
      secretResolver.resolve.mockReturnValue("not-json");
      await expect(adapter.execute(baseRequest)).rejects.toThrow(/did not parse as JSON/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("checkStatus", () => {
    it("returns not_found when no providerReference was ever recorded — never guesses via an unverified filter-by-externalTxId lookup", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", assetNetworkId: "an-1", custodyReference: null });
      const result = await adapter.checkStatus("wd-1");
      expect(result.status).toBe("not_found");
    });

    it("looks up the stored providerReference and maps the real result", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", assetNetworkId: "an-1", custodyReference: "fb-1" });
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "fb-1", status: "COMPLETED", txHash: "0xreal" }) });

      const result = await adapter.checkStatus("wd-1");

      expect(result).toEqual({ status: "broadcast", txHash: "0xreal", providerReference: "fb-1" });
      expect(fetchMock.mock.calls[0][0]).toBe("https://sandbox-api.fireblocks.io/v1/transactions/fb-1");
    });

    it("returns not_found (never throws) when Fireblocks itself 404s the direct GET-by-id lookup", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", assetNetworkId: "an-1", custodyReference: "fb-1" });
      fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => JSON.stringify({ message: "not found" }) });

      const result = await adapter.checkStatus("wd-1");
      expect(result.status).toBe("not_found");
    });

    it("still throws (never silently swallows) a non-404 error, e.g. an auth failure", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", assetNetworkId: "an-1", custodyReference: "fb-1" });
      fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ message: "unauthorized" }) });

      await expect(adapter.checkStatus("wd-1")).rejects.toMatchObject({ status: 401 });
    });
  });

  describe("A1 — environment isolation (security review finding, defense-in-depth even if the factory is bypassed)", () => {
    const baseRequest = { withdrawalId: "wd-1", assetNetworkId: "an-1", destinationAddress: "0xdest", amount: "0.01", idempotencyKey: "wd-1" };

    it("refuses execute() when the linked CustodyProviderConfig is flagged PRODUCTION but the process is sandbox", async () => {
      prisma.custodyProviderConfig.findUnique.mockResolvedValue({ ...providerConfig, environment: "PRODUCTION" });
      config.get.mockReturnValue("sandbox");

      await expect(adapter.execute(baseRequest)).rejects.toThrow(/flagged PRODUCTION/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses checkStatus() when the linked CustodyProviderConfig is flagged PRODUCTION but the process is sandbox", async () => {
      prisma.withdrawal.findUnique.mockResolvedValue({ id: "wd-1", assetNetworkId: "an-1", custodyReference: "fb-1" });
      prisma.custodyProviderConfig.findUnique.mockResolvedValue({ ...providerConfig, environment: "PRODUCTION" });
      config.get.mockReturnValue("sandbox");

      await expect(adapter.checkStatus("wd-1")).rejects.toThrow(/flagged PRODUCTION/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses execute() for ANY non-production appEnvironment value (e.g. 'staging') paired with a PRODUCTION-flagged config", async () => {
      prisma.custodyProviderConfig.findUnique.mockResolvedValue({ ...providerConfig, environment: "PRODUCTION" });
      config.get.mockReturnValue("staging");

      await expect(adapter.execute(baseRequest)).rejects.toThrow(/flagged PRODUCTION/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("succeeds when the CustodyProviderConfig environment matches the running process", async () => {
      prisma.custodyProviderConfig.findUnique.mockResolvedValue({ ...providerConfig, environment: "SANDBOX" });
      config.get.mockReturnValue("sandbox");
      fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ id: "fb-1", status: "SUBMITTED" }) });

      const result = await adapter.execute(baseRequest);
      expect(result).toEqual({ status: "awaiting_manual_broadcast", providerReference: "fb-1" });
    });
  });
});
