import { FireblocksCustodyAdapter } from "../../src/wallet/executors/fireblocks/fireblocks-custody.adapter";
import { ManualBroadcastExecutor } from "../../src/wallet/executors/manual-broadcast.executor";
import { ProductionCustodyExecutor } from "../../src/wallet/executors/production-custody.executor";
import { WithdrawalExecutorFactory } from "../../src/wallet/executors/withdrawal-executor.factory";
import { WithdrawalComplianceGate } from "../../src/wallet/withdrawals/compliance/withdrawal-compliance-gate.interface";
import { CustodyProviderConfigService } from "../../src/wallet/provider-config/custody-provider-config.service";
import { ComplianceProviderConfigService } from "../../src/wallet/provider-config/compliance-provider-config.service";
import { SecretResolverService } from "../../src/wallet/provider-config/secret-resolver.service";
import { ProductionSafetyGate } from "../../src/wallet/production-safety.gate";
import { getAssetNetwork, prisma } from "./helpers";

function makeExecutorFactory(appEnvironment: "sandbox" | "production") {
  const config = { get: () => appEnvironment } as never;
  return new WithdrawalExecutorFactory(
    prisma,
    config,
    new ManualBroadcastExecutor(),
    new ProductionCustodyExecutor(),
    new FireblocksCustodyAdapter(prisma, new SecretResolverService(), config),
  );
}

function makeSafetyGate(appEnvironment: "sandbox" | "production", complianceGate: WithdrawalComplianceGate) {
  return new ProductionSafetyGate({ get: () => appEnvironment } as never, prisma, complianceGate);
}

const realCompliantGate: WithdrawalComplianceGate = { assess: async () => ({ decision: "PASS" }) } as never;

describe("Provider configuration (real Postgres)", () => {
  const custodyConfigService = new CustodyProviderConfigService(prisma);
  const complianceConfigService = new ComplianceProviderConfigService(prisma);

  describe("USDT safety (Phase 14A section 4)", () => {
    it("the seeded USDT/ethereum-sepolia row is inactive — no real contract address exists to activate it with", async () => {
      const usdtSepolia = await getAssetNetwork("USDT", "ethereum-sepolia");
      expect(usdtSepolia.isActive).toBe(false);
      expect(usdtSepolia.contractAddress).toBeNull();
    });

    it("the DB itself refuses to activate a non-native AssetNetwork with no contractAddress, even bypassing AssetsNetworksService entirely", async () => {
      const usdtSepolia = await getAssetNetwork("USDT", "ethereum-sepolia");
      await expect(
        prisma.assetNetwork.update({ where: { id: usdtSepolia.id }, data: { isActive: true } }),
      ).rejects.toThrow(/asset_networks_active_token_requires_contract_check/);
    });

    it("a non-native AssetNetwork WITH a real contractAddress activates fine at the DB level", async () => {
      const usdcSepolia = await getAssetNetwork("USDC", "ethereum-sepolia");
      // Already active per seed; toggle off and back on to prove the
      // constraint doesn't over-fire on a genuinely valid row.
      await prisma.assetNetwork.update({ where: { id: usdcSepolia.id }, data: { isActive: false } });
      await expect(prisma.assetNetwork.update({ where: { id: usdcSepolia.id }, data: { isActive: true } })).resolves.toBeDefined();
    });
  });

  describe("custody provider config secret-reference safety (DB level)", () => {
    it("rejects a raw-looking credentialsSecretRef via a direct write, bypassing CustodyProviderConfigService entirely", async () => {
      await expect(
        prisma.custodyProviderConfig.create({
          data: { providerName: "Fireblocks", environment: "PRODUCTION", credentialsSecretRef: "sk_live_raw_secret_value" },
        }),
      ).rejects.toThrow(/custody_provider_configs_credentials_ref_scheme_check/);
    });

    it("accepts a well-formed scheme:path reference", async () => {
      const created = await prisma.custodyProviderConfig.create({
        data: { providerName: "Fireblocks", environment: "SANDBOX", credentialsSecretRef: "env:FIREBLOCKS_API_KEY" },
      });
      expect(created.id).toBeTruthy();
    });
  });

  describe("withdrawal_execution_configs_custody_requires_provider_check (DB level)", () => {
    it("rejects PRODUCTION_CUSTODY with no linked custody provider config via a direct write", async () => {
      const ethSepolia = await getAssetNetwork("ETH", "ethereum-sepolia");
      await expect(
        prisma.withdrawalExecutionConfig.upsert({
          where: { assetNetworkId: ethSepolia.id },
          create: { assetNetworkId: ethSepolia.id, environment: "PRODUCTION", executorType: "PRODUCTION_CUSTODY" },
          update: { executorType: "PRODUCTION_CUSTODY", custodyProviderConfigId: null },
        }),
      ).rejects.toThrow(/withdrawal_execution_configs_custody_requires_provider_check/);
    });
  });

  describe("end-to-end custody configuration workflow", () => {
    it("WithdrawalExecutorFactory refuses in production until the linked custody provider config is enabled, then succeeds once it is", async () => {
      const solDevnet = await getAssetNetwork("SOL", "solana-devnet");
      const providerConfig = await custodyConfigService.createCustodyProviderConfig({
        providerName: "Fireblocks",
        environment: "PRODUCTION",
        credentialsSecretRef: "env:FIREBLOCKS_API_KEY_TEST",
      });
      await custodyConfigService.setWithdrawalExecutionConfig({
        assetNetworkId: solDevnet.id,
        environment: "PRODUCTION",
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfigId: providerConfig.id,
      });

      const productionFactory = makeExecutorFactory("production");
      await expect(productionFactory.resolve(solDevnet.id)).rejects.toThrow(/not enabled/);

      await custodyConfigService.setCustodyProviderEnabled(providerConfig.id, true);
      const executor = await productionFactory.resolve(solDevnet.id);
      expect(executor).toBeInstanceOf(ProductionCustodyExecutor);
    });

    it("rejects linking a PRODUCTION execution config to a SANDBOX provider config", async () => {
      const xrpTestnet = await getAssetNetwork("XRP", "xrpl-testnet");
      const sandboxProvider = await custodyConfigService.createCustodyProviderConfig({ providerName: "BitGo", environment: "SANDBOX" });

      await expect(
        custodyConfigService.setWithdrawalExecutionConfig({
          assetNetworkId: xrpTestnet.id,
          environment: "PRODUCTION",
          executorType: "PRODUCTION_CUSTODY",
          custodyProviderConfigId: sandboxProvider.id,
        }),
      ).rejects.toThrow(/[Ee]nvironment mismatch/);
    });
  });

  describe("compliance provider configuration workflow", () => {
    it("creates disabled, lists by category/environment, and enables", async () => {
      const created = await complianceConfigService.createComplianceProviderConfig({
        category: "SANCTIONS_KYT",
        providerName: "Chainalysis",
        environment: "PRODUCTION",
        credentialsSecretRef: "secretsmanager:prod/chainalysis/key",
      });
      expect(created.isEnabled).toBe(false);

      const listed = await complianceConfigService.listComplianceProviderConfigs({ category: "SANCTIONS_KYT", environment: "PRODUCTION" });
      expect(listed.map((c) => c.id)).toContain(created.id);

      const enabled = await complianceConfigService.setComplianceProviderEnabled(created.id, true);
      expect(enabled.isEnabled).toBe(true);
    });
  });

  describe("Phase 14B.1 section 7 — safe staging startup (APP_ENVIRONMENT=sandbox), real Postgres end-to-end", () => {
    it("ALLOWS: sandbox process + a real, enabled, SANDBOX-flagged, fully-verified Fireblocks config resolves to the real adapter", async () => {
      const ethSepolia = await getAssetNetwork("ETH", "ethereum-sepolia");
      const providerConfig = await custodyConfigService.createCustodyProviderConfig({
        providerName: "Fireblocks",
        environment: "SANDBOX",
        credentialsSecretRef: "env:FIREBLOCKS_SANDBOX_CREDENTIALS_TEST",
        apiBaseUrl: "https://sandbox-api.fireblocks.io/v1",
      });
      await custodyConfigService.setCustodyProviderEnabled(providerConfig.id, true);
      await custodyConfigService.setWithdrawalExecutionConfig({
        assetNetworkId: ethSepolia.id,
        environment: "SANDBOX",
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfigId: providerConfig.id,
        providerAssetId: "ETH_TEST", // an admin-verified value, not guessed
      });

      const sandboxFactory = makeExecutorFactory("sandbox");
      const executor = await sandboxFactory.resolve(ethSepolia.id);
      expect(executor).toBeInstanceOf(FireblocksCustodyAdapter);
    });

    it("REJECTS: sandbox process + a PRODUCTION-flagged Fireblocks config, even though everything else is otherwise valid (security review finding A1)", async () => {
      const ethSepolia = await getAssetNetwork("ETH", "ethereum-sepolia");
      const providerConfig = await custodyConfigService.createCustodyProviderConfig({
        providerName: "Fireblocks",
        environment: "PRODUCTION",
        credentialsSecretRef: "env:FIREBLOCKS_PRODUCTION_CREDENTIALS_TEST",
        apiBaseUrl: "https://api.fireblocks.io/v1",
      });
      await custodyConfigService.setCustodyProviderEnabled(providerConfig.id, true);
      await custodyConfigService.setWithdrawalExecutionConfig({
        assetNetworkId: ethSepolia.id,
        environment: "PRODUCTION",
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfigId: providerConfig.id,
        providerAssetId: "ETH",
      });

      const sandboxFactory = makeExecutorFactory("sandbox");
      await expect(sandboxFactory.resolve(ethSepolia.id)).rejects.toThrow(/flagged PRODUCTION/);
    });

    it("REJECTS: sandbox process + PRODUCTION_CUSTODY selected but no custody provider config linked at all — blocked twice over (DB CHECK constraint AND the factory's own check)", async () => {
      const bitcoinTestnet = await getAssetNetwork("BTC", "bitcoin-testnet");
      // The DB itself already refuses to persist this combination at all
      // — see the "withdrawal_execution_configs_custody_requires_provider_check
      // (DB level)" describe block above for that direct proof. This test
      // instead proves the SERVICE layer (what a real admin API call goes
      // through) surfaces the identical refusal, so "missing provider
      // config" can never reach WithdrawalExecutorFactory.resolve() as a
      // linked-but-null relation in the first place.
      await expect(
        custodyConfigService.setWithdrawalExecutionConfig({
          assetNetworkId: bitcoinTestnet.id,
          environment: "SANDBOX",
          executorType: "PRODUCTION_CUSTODY",
          custodyProviderConfigId: undefined,
        }),
      ).rejects.toThrow(/requires a custodyProviderConfigId/);
    });

    it("REJECTS: unverified asset/network — a real, enabled, environment-matching Fireblocks config with NO providerAssetId set", async () => {
      const solDevnet = await getAssetNetwork("SOL", "solana-devnet");
      const providerConfig = await custodyConfigService.createCustodyProviderConfig({
        providerName: "Fireblocks",
        environment: "SANDBOX",
        credentialsSecretRef: "env:FIREBLOCKS_SANDBOX_CREDENTIALS_TEST_2",
      });
      await custodyConfigService.setCustodyProviderEnabled(providerConfig.id, true);
      await custodyConfigService.setWithdrawalExecutionConfig({
        assetNetworkId: solDevnet.id,
        environment: "SANDBOX",
        executorType: "PRODUCTION_CUSTODY",
        custodyProviderConfigId: providerConfig.id,
        // providerAssetId deliberately omitted — never guessed.
      });

      const sandboxFactory = makeExecutorFactory("sandbox");
      await expect(sandboxFactory.resolve(solDevnet.id)).rejects.toThrow(/does not support asset\/network/);
    });
  });

  describe("ProductionSafetyGate — fail-closed production behavior against real configuration state", () => {
    // ProductionSafetyGate's compliance/custody checks are global (they
    // scan every row in the database), so a "passes cleanly" case is
    // exercised at the unit level (production-safety.gate.spec.ts) with
    // a fully controlled, isolated Prisma mock — asserting it here would
    // depend on every OTHER integration spec file (and every other test
    // in this one) never leaving behind an un-backed PRODUCTION_CUSTODY
    // row anywhere in this shared test database, which is exactly the
    // kind of cross-file fragility integration tests should avoid. This
    // integration test instead confirms the real Prisma queries
    // themselves correctly detect a genuine gap against the real schema
    // — the thing a mocked unit test alone can't prove.
    it("refuses production when no enabled KYC ComplianceProviderConfig exists for PRODUCTION, using real queries against the real schema", async () => {
      const gate = makeSafetyGate("production", realCompliantGate);
      const kycCount = await prisma.complianceProviderConfig.count({
        where: { category: "KYC", environment: "PRODUCTION", isEnabled: true },
      });
      expect(kycCount).toBe(0); // nothing in this test creates one
      await expect(gate.onApplicationBootstrap()).rejects.toThrow(/KYC ComplianceProviderConfig/);
    });
  });
});
