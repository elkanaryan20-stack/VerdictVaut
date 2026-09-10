/**
 * Phase 14B.1 — a standalone, READ-ONLY staging/sandbox preflight check
 * for the Fireblocks (and Elliptic) sandbox smoke test described in
 * docs/fireblocks-sandbox-smoke-test.md. Complements (does not replace)
 * scripts/production-readiness-check.js, which asks "can this safely
 * run in PRODUCTION" — this script instead asks "is a genuine SANDBOX
 * smoke test actually ready to attempt right now."
 *
 * This script NEVER:
 *   - prints a secret value (only variable NAMES and boolean presence);
 *   - executes a withdrawal, sends funds, or mutates any balance;
 *   - creates, enables, or modifies a ProviderConfig row;
 *   - flips APP_ENVIRONMENT or any production configuration.
 * Every DB operation below is a read (SELECT / Prisma find-many / count)
 * — grep this file for anything else if you don't trust that claim.
 *
 * Usage: `node scripts/staging-preflight-check.js`
 * Requires a reachable DATABASE_URL (same as the real app would use).
 */

const fs = require("fs");
const path = require("path");

const RESULTS = [];
function check(label, status, detail) {
  RESULTS.push({ label, status, detail });
}

function maskedEnvPresence(names) {
  // Returns {name: boolean} — never the value itself.
  const out = {};
  for (const name of names) out[name] = Boolean(process.env[name]);
  return out;
}

async function main() {
  console.log("=== VerdictVaut staging/sandbox preflight check (Phase 14B.1) ===\n");
  console.log("This script is READ-ONLY: it never mutates data, sends funds, or prints secret values.\n");

  // ── 1. APP_ENVIRONMENT ──────────────────────────────────────────────
  const appEnvironment = process.env.APP_ENVIRONMENT || "sandbox";
  if (appEnvironment === "production") {
    check("APP_ENVIRONMENT is sandbox-appropriate for a smoke test", "FAIL", `APP_ENVIRONMENT=production — this script is for preparing a SANDBOX smoke test, not production. Refusing to proceed with the rest of the checks.`);
    printAndExit();
    return;
  }
  check("APP_ENVIRONMENT is sandbox-appropriate for a smoke test", process.env.APP_ENVIRONMENT ? "PASS" : "WARN", process.env.APP_ENVIRONMENT ? `APP_ENVIRONMENT=${appEnvironment}` : "unset — defaults to sandbox; set it explicitly for clarity in a real staging deployment");

  // ── 2. Required non-secret variables present ───────────────────────
  check("DATABASE_URL is set", process.env.DATABASE_URL ? "PASS" : "FAIL", process.env.DATABASE_URL ? "set" : "missing — cannot run any DB-dependent check below");

  const credentialPresence = maskedEnvPresence(["FIREBLOCKS_SANDBOX_CREDENTIALS", "FIREBLOCKS_WEBHOOK_PUBLIC_KEY", "ELLIPTIC_SANDBOX_CREDENTIALS"]);
  for (const [name, present] of Object.entries(credentialPresence)) {
    check(`${name} is set (presence only — value never read by this script)`, present ? "PASS" : "WARN", present ? "present" : "not set — required before a real Fireblocks/Elliptic sandbox call can succeed, but its ABSENCE is expected/safe before you've provisioned real sandbox credentials");
  }

  if (!process.env.DATABASE_URL) {
    printAndExit();
    return;
  }

  // ── 3/4. Database connectivity + migrations ────────────────────────
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  let dbReachable = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
    check("Database is reachable", "PASS", "connected");
  } catch (error) {
    check("Database is reachable", "FAIL", error.message);
  }

  if (dbReachable) {
    try {
      const migrationsDir = path.join(__dirname, "..", "prisma", "migrations");
      const onDisk = fs
        .readdirSync(migrationsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      const appliedRows = await prisma.$queryRaw`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
      const applied = new Set(appliedRows.map((r) => r.migration_name));
      const missing = onDisk.filter((name) => !applied.has(name));
      check("All migrations on disk are applied to this database", missing.length === 0 ? "PASS" : "FAIL", missing.length === 0 ? `${onDisk.length} migration(s) applied` : `${missing.length} unapplied: ${missing.join(", ")} — run \`npx prisma migrate deploy\``);
    } catch (error) {
      check("All migrations on disk are applied to this database", "FAIL", `could not read migration status — ${error.message}`);
    }

    // ── 5/6/8. Provider configuration existence, environment, mismatch ─
    let requiredProviderConfigEnvironment;
    try {
      require("ts-node/register");
      ({ requiredProviderConfigEnvironment } = require("../src/wallet/provider-config/provider-environment.util"));
    } catch (error) {
      check("Could not load provider-environment.util for cross-checks", "WARN", error.message);
    }

    try {
      const fireblocksConfigs = await prisma.custodyProviderConfig.findMany({
        where: { providerName: { equals: "Fireblocks", mode: "insensitive" } },
        select: { id: true, environment: true, isEnabled: true, apiBaseUrl: true, credentialsSecretRef: true },
      });
      check("At least one Fireblocks CustodyProviderConfig exists", fireblocksConfigs.length > 0 ? "PASS" : "WARN", fireblocksConfigs.length > 0 ? `${fireblocksConfigs.length} found` : "none configured yet — expected before you run docs/provider-integration.md §10's setup steps");

      if (requiredProviderConfigEnvironment) {
        const required = requiredProviderConfigEnvironment(appEnvironment);
        const mismatched = fireblocksConfigs.filter((c) => c.environment !== required && c.isEnabled);
        check(
          `Every ENABLED Fireblocks config matches this process's required environment (${required})`,
          mismatched.length === 0 ? "PASS" : "FAIL",
          mismatched.length === 0 ? "consistent" : `${mismatched.length} enabled config(s) flagged ${mismatched.map((c) => c.environment).join(", ")} — WithdrawalExecutorFactory/FireblocksCustodyAdapter will refuse these regardless, but fix the configuration rather than relying on that`,
        );
      }

      const enabledSandboxFireblocks = fireblocksConfigs.filter((c) => c.environment === "SANDBOX" && c.isEnabled);
      for (const cfg of enabledSandboxFireblocks) {
        check(`CustodyProviderConfig ${cfg.id} has apiBaseUrl and credentialsSecretRef set`, cfg.apiBaseUrl && cfg.credentialsSecretRef ? "PASS" : "FAIL", cfg.apiBaseUrl && cfg.credentialsSecretRef ? "both set" : "missing one or both — FireblocksCustodyAdapter will refuse to execute");
      }

      // ── 6. Configured asset/network + capability cross-check ────────
      const withdrawalConfigs = await prisma.withdrawalExecutionConfig.findMany({
        where: { executorType: "PRODUCTION_CUSTODY" },
        include: { custodyProviderConfig: true, assetNetwork: { include: { asset: true, network: true } } },
      });
      check("WithdrawalExecutionConfig rows selecting PRODUCTION_CUSTODY", "PASS", `${withdrawalConfigs.length} found (informational — see individual checks below)`);

      let capabilityMatrix;
      try {
        const { PROVIDER_CAPABILITY_MATRIX } = require("../src/wallet/provider-config/provider-capability-matrix");
        capabilityMatrix = PROVIDER_CAPABILITY_MATRIX;
      } catch (error) {
        check("Could not load provider-capability-matrix for cross-checks", "WARN", error.message);
      }

      for (const cfg of withdrawalConfigs) {
        const label = `${cfg.assetNetwork?.asset?.symbol ?? "?"}/${cfg.assetNetwork?.network?.code ?? "?"} (assetNetworkId ${cfg.assetNetworkId})`;
        if (!cfg.providerAssetId) {
          check(`${label}: providerAssetId is set`, "FAIL", "not set — this executor will refuse every withdrawal on this asset/network (fail-closed, not a bug)");
        } else {
          check(`${label}: providerAssetId is set`, "PASS", `set to a value an admin must have independently verified`);
        }

        if (capabilityMatrix && cfg.custodyProviderConfig) {
          const entry = capabilityMatrix.find((e) => e.provider.toUpperCase() === cfg.custodyProviderConfig.providerName.toUpperCase() && e.capability === "custody_execution" && e.networkFamily === cfg.assetNetwork?.network?.family);
          if (entry) {
            check(`${label}: provider capability status`, entry.status === "UNSUPPORTED" ? "FAIL" : entry.status === "VERIFIED" ? "PASS" : "WARN", `${entry.status}${entry.liveVerified ? " (live-verified)" : " (NOT live-verified — see provider-capability-matrix.ts)"}`);
          } else {
            check(`${label}: provider capability status`, "WARN", "no matching capability matrix entry found for this provider/network family — treat as UNSUPPORTED until one is added");
          }
        }
      }

      const ellipticConfigs = await prisma.complianceProviderConfig.findMany({
        where: { providerName: { equals: "Elliptic", mode: "insensitive" } },
        select: { id: true, environment: true, isEnabled: true, riskScoreMediumThreshold: true, riskScoreHighThreshold: true },
      });
      check("Elliptic ComplianceProviderConfig configured (optional)", ellipticConfigs.length > 0 ? "PASS" : "WARN", ellipticConfigs.length > 0 ? `${ellipticConfigs.length} found` : "none configured — address-risk screening will remain DEFERRED, which is safe but not what a full smoke test would exercise");
      for (const cfg of ellipticConfigs.filter((c) => c.isEnabled)) {
        const hasThresholds = cfg.riskScoreMediumThreshold != null && cfg.riskScoreHighThreshold != null;
        check(`ComplianceProviderConfig ${cfg.id}: risk-score thresholds configured`, hasThresholds ? "PASS" : "FAIL", hasThresholds ? "both set" : "missing — EllipticAddressRiskGate will report ERROR (fail-closed) for every screening");
      }
    } catch (error) {
      check("Provider configuration checks", "FAIL", error.message);
    }
  }

  await prisma.$disconnect();
  printAndExit();
}

function printAndExit() {
  for (const r of RESULTS) {
    console.log(`  [${r.status}] ${r.label}${r.detail ? " — " + r.detail : ""}`);
  }
  const fails = RESULTS.filter((r) => r.status === "FAIL").length;
  const warns = RESULTS.filter((r) => r.status === "WARN").length;
  const passes = RESULTS.filter((r) => r.status === "PASS").length;
  console.log(`\n=== Summary: ${passes} PASS / ${warns} WARN / ${fails} FAIL (of ${RESULTS.length}) ===`);
  if (fails > 0) {
    console.log("NOT READY for a sandbox smoke test — resolve the FAIL item(s) above first.");
    process.exitCode = 1;
  } else if (warns > 0) {
    console.log("Partially ready — WARN items are expected before real credentials/config are provisioned; resolve them per docs/fireblocks-sandbox-smoke-test.md before attempting a live call.");
  } else {
    console.log("All checks passed. This does NOT itself prove the real Fireblocks/Elliptic account will accept a request — only that VerdictVaut's own configuration is internally consistent and ready to attempt one.");
  }
}

main().catch((error) => {
  console.error("Preflight check crashed:", error.message);
  process.exitCode = 1;
});
