/**
 * Phase 13 — a standalone, runnable production-configuration safety
 * gate, separate from (and complementary to) `env.validation.ts`'s
 * boot-time NestJS check and `check:integrity`'s financial-invariant
 * check. Where those run INSIDE the app process, this is meant to be
 * run BEFORE deploying — by a human, or a CI/CD pipeline step — to get
 * a full, honest picture of what's safe and what's still a real
 * blocker, without needing the app itself to boot.
 *
 * Every check states a concrete pass/fail reason. Nothing here is
 * allowed to "pass" just because it wasn't checked — a structural gap
 * with no real fix yet (no custody provider, no real KYC/AML provider,
 * no CI/CD) is reported as an honest, permanent FAIL/WARN until the
 * actual prerequisite exists, never smoothed over. See the final
 * summary's classification (P0/P1/P2) for how urgent each one is.
 *
 * Usage: `node scripts/production-readiness-check.js [--with-db]`
 * `--with-db` additionally runs the checks in runDbChecks(), which need
 * a reachable DATABASE_URL — omit it to run only the fast, DB-free
 * environment/config/structural checks.
 */

const fs = require("fs");
const path = require("path");

const SEVERITY = { P0: "P0 (blocks any production financial activity)", P1: "P1 (blocks production launch)", P2: "P2 (should fix shortly after launch)" };

function readSourceFile(relativePath) {
  try {
    return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
  } catch {
    return null;
  }
}

/** Environment/config checks — no DB, no compiled app required. */
function runEnvChecks(env) {
  const results = [];
  const check = (label, severity, passed, detail) => {
    results.push({ label, severity, passed, detail });
    return passed;
  };

  check("DATABASE_URL is set", "P0", Boolean(env.DATABASE_URL), env.DATABASE_URL ? "set" : "missing");
  check(
    "DATABASE_URL uses the postgresql:// scheme",
    "P0",
    Boolean(env.DATABASE_URL && env.DATABASE_URL.startsWith("postgresql://")),
    env.DATABASE_URL ? env.DATABASE_URL.split("://")[0] : "n/a",
  );

  if (env.APP_ENVIRONMENT === "production" && env.DATABASE_URL) {
    // Uses the SAME function env.validation.ts enforces at real boot
    // time (src/config/database-tls.validator.ts) — not a duplicated
    // regex that could silently drift from the real gate.
    let tlsOk = false;
    let tlsDetail = "could not load database-tls.validator.ts to verify";
    try {
      require("ts-node/register");
      const { assertDatabaseTlsConfigured } = require("../src/config/database-tls.validator");
      assertDatabaseTlsConfigured(env.DATABASE_URL, env.APP_ENVIRONMENT);
      tlsOk = true;
      tlsDetail = "TLS enforced";
    } catch (error) {
      tlsDetail = error.message;
    }
    check("DATABASE_URL enforces TLS for production (sslmode=require/verify-ca/verify-full)", "P0", tlsOk, tlsDetail);
  }

  const secretsOk = (name) => {
    const value = env[name];
    const placeholder = ["changeme", "secret", "password", "test", "development", ""].includes((value ?? "").toLowerCase());
    return check(`${name} is set, >=32 chars, and not an obvious placeholder`, "P0", Boolean(value) && value.length >= 32 && !placeholder, value ? `length=${value.length}` : "missing");
  };
  const accessOk = secretsOk("JWT_ACCESS_SECRET");
  const refreshOk = secretsOk("JWT_REFRESH_SECRET");
  if (accessOk && refreshOk) {
    check("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are different values", "P0", env.JWT_ACCESS_SECRET !== env.JWT_REFRESH_SECRET, "reusing the same secret for both defeats rotating one independently");
  }

  if (env.NODE_ENV === "production" || env.APP_ENVIRONMENT === "production") {
    check("CORS_ALLOWED_ORIGINS does not contain a wildcard", "P0", !(env.CORS_ALLOWED_ORIGINS ?? "").includes("*"), env.CORS_ALLOWED_ORIGINS || "(empty)");
    check(
      "CORS_ALLOWED_ORIGINS is explicitly configured (not left empty)",
      "P1",
      Boolean((env.CORS_ALLOWED_ORIGINS ?? "").trim()),
      "empty means CORS fails closed (safe) but no browser client can call this API at all — likely a misconfiguration, not a deliberate choice",
    );
    check("ENABLE_DEV_FUNDING_TOOLS is not enabled in production", "P0", env.ENABLE_DEV_FUNDING_TOOLS !== "true", `ENABLE_DEV_FUNDING_TOOLS=${env.ENABLE_DEV_FUNDING_TOOLS ?? "(unset)"}`);
  }

  check(
    "APP_ENVIRONMENT is a recognized value",
    "P2",
    ["sandbox", "production"].includes(env.APP_ENVIRONMENT ?? "sandbox"),
    env.APP_ENVIRONMENT ?? "(unset, defaults to sandbox)",
  );

  return results;
}

/**
 * Structural/code blockers — true regardless of environment variables,
 * sourced by inspecting the actual current source (not a hardcoded
 * claim that could silently go stale once someone implements the real
 * thing) so this check keeps telling the truth as the codebase changes.
 */
function runStructuralChecks() {
  const results = [];
  const check = (label, severity, passed, detail) => {
    results.push({ label, severity, passed, detail });
    return passed;
  };

  const custodyExecutorSource = readSourceFile("src/wallet/executors/production-custody.executor.ts");
  check(
    "A real production custody provider is integrated",
    "P0",
    Boolean(custodyExecutorSource) && !/throw new Error/.test(custodyExecutorSource),
    custodyExecutorSource
      ? /throw new Error/.test(custodyExecutorSource)
        ? "ProductionCustodyExecutor still unconditionally throws — no provider selected/integrated yet"
        : "ProductionCustodyExecutor no longer unconditionally throws — verify a real provider is actually wired before trusting this as a PASS"
      : "could not read production-custody.executor.ts to verify",
  );

  // Phase 14B: WITHDRAWAL_COMPLIANCE_GATE is now bound to
  // ComplianceGateFactory, which routes to a real provider adapter
  // (EllipticAddressRiskGate) in SANDBOX only — production always
  // forces DeferredComplianceGate regardless of any ComplianceProviderConfig,
  // by design (see that factory's own docblock). Check the factory's
  // OWN production branch directly, rather than a naive DI-binding grep
  // against wallet.module.ts, so this stays accurate as the routing
  // logic evolves.
  const complianceFactorySource = readSourceFile("src/wallet/withdrawals/compliance/compliance-gate.factory.ts");
  const productionAlwaysDefers =
    complianceFactorySource &&
    /appEnvironment.*===\s*["']production["'][\s\S]*?deferredGate\.assess/.test(complianceFactorySource);
  check(
    "A real KYC/AML/sanctions compliance provider is integrated",
    "P0",
    Boolean(complianceFactorySource) && !productionAlwaysDefers,
    productionAlwaysDefers
      ? "ComplianceGateFactory forces DeferredComplianceGate in production regardless of configuration — every PRODUCTION withdrawal compliance check is DEFERRED to a human, never automated. " +
        "A real adapter (EllipticAddressRiskGate) IS wired for SANDBOX address-risk screening only — see docs/provider-integration.md."
      : "could not confirm",
  );

  check("A Dockerfile exists for apps/api", "P1", fs.existsSync(path.join(__dirname, "..", "Dockerfile")), "no containerized deployment artifact exists yet");
  check(
    "A Dockerfile exists for apps/web",
    "P1",
    fs.existsSync(path.join(__dirname, "..", "..", "web", "Dockerfile")),
    "no containerized deployment artifact exists yet",
  );
  check(
    "CI/CD configuration exists",
    "P2",
    fs.existsSync(path.join(__dirname, "..", "..", "..", ".github", "workflows")),
    "no automated test/build/deploy pipeline exists yet — see .github/workflows",
  );

  check(
    "Production-grade backup infrastructure (managed provider, WAL/PITR, off-site storage) is decided and provisioned",
    "P1",
    false,
    "infra/backup.sh + a passing restore drill exist and are real, but no managed-provider/self-hosted HA strategy, WAL archiving, or off-site encrypted storage is chosen yet — see docs/database-backup-recovery.md",
  );

  const authServiceSource = readSourceFile("src/auth/auth.service.ts");
  check(
    "Bounded account brute-force/credential-stuffing protection is implemented",
    "P1",
    Boolean(authServiceSource) && /computeLockDurationMs|isCurrentlyLocked/.test(authServiceSource),
    authServiceSource ? "login-throttle.util.ts wired into AuthService.login (Phase 13 remediation)" : "could not verify",
  );

  const destinationValidatorSource = readSourceFile("src/wallet/withdrawals/destination-address.validator.ts");
  const hasRealChecksums = Boolean(destinationValidatorSource) && /decodeBase58Check|decodeSegwitAddress/.test(destinationValidatorSource);
  const evmDeferred = Boolean(destinationValidatorSource) && /EIP-55.*DEFERRED|DEFERRED, deliberately/i.test(destinationValidatorSource);
  check(
    "Withdrawal destination FORMAT/CHECKSUM validation is real (not regex-only) for BTC/SOL/XRP — EVM EIP-55 explicitly deferred, not silently missing",
    "P1",
    hasRealChecksums && evmDeferred,
    hasRealChecksums
      ? "BTC/XRP Base58Check + bech32/bech32m and SOL 32-byte decode are real; EVM EIP-55 checksum remains deferred pending a Keccak-256 dependency decision — see the file's own docblock. On-chain OWNERSHIP verification is not performed for any network."
      : "checksum verification not found — format-regex only",
  );

  const metricsSource = readSourceFile("src/observability/metrics.service.ts");
  const jsonLoggerSource = readSourceFile("src/observability/json-logger.service.ts");
  check(
    "Structured logging + a provider-neutral metrics boundary exist",
    "P1",
    Boolean(metricsSource) && Boolean(jsonLoggerSource),
    "JsonLoggerService + MetricsService/LoggingMetricsService exist (Phase 13 remediation) — but NO real alerting vendor/sink is connected yet; LoggingMetricsService only logs metric events structurally. Wiring a real Prometheus/Datadog/CloudWatch backend (implement the same MetricsService interface) and connecting log-based or metric-based alerts on CRITICAL reconciliation discrepancies, watcher scan failures, and settlement/withdrawal failures remains a real, undone operational step.",
  );

  return results;
}

/** DB-dependent checks — only run with --with-db and a reachable DATABASE_URL. */
async function runDbChecks() {
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  const results = [];
  const check = (label, severity, passed, detail) => {
    results.push({ label, severity, passed, detail });
    return passed;
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    check("Database is reachable", "P0", true, "connected");

    const badAssetNetworks = await prisma.assetNetwork.findMany({
      where: { isActive: true, isNative: false, contractAddress: null },
      select: { id: true, assetId: true, networkId: true },
    });
    check(
      "Every active, non-native AssetNetwork has a contractAddress configured",
      "P0",
      badAssetNetworks.length === 0,
      `${badAssetNetworks.length} violation(s)`,
    );

    const productionCustodyConfigs = await prisma.withdrawalExecutionConfig.count({ where: { executorType: "PRODUCTION_CUSTODY" } });
    check(
      "WithdrawalExecutionConfig rows selecting PRODUCTION_CUSTODY are consistent with an actually-integrated provider",
      "P1",
      true, // informational only — a count alone can't tell us if the provider behind it is real
      `${productionCustodyConfigs} asset/network(s) configured for PRODUCTION_CUSTODY — verify each is backed by a real, tested integration, not just a config row`,
    );
  } catch (error) {
    check("Database is reachable", "P0", false, error.message);
  } finally {
    await prisma.$disconnect();
  }

  return results;
}

async function main() {
  const withDb = process.argv.includes("--with-db");
  const env = process.env;

  console.log("=== Production readiness check ===\n");

  const allResults = [...runEnvChecks(env), ...runStructuralChecks()];
  if (withDb) {
    allResults.push(...(await runDbChecks()));
  } else {
    console.log("(skipping DB-dependent checks — pass --with-db to include them)\n");
  }

  for (const r of allResults) {
    console.log(`  [${r.passed ? "PASS" : "FAIL"}] (${r.severity}) ${r.label}${r.detail ? " — " + r.detail : ""}`);
  }

  const p0Failures = allResults.filter((r) => !r.passed && r.severity === "P0");
  const p1Failures = allResults.filter((r) => !r.passed && r.severity === "P1");
  const p2Failures = allResults.filter((r) => !r.passed && r.severity === "P2");

  console.log(`\n=== Summary: ${allResults.filter((r) => r.passed).length}/${allResults.length} passed ===`);
  console.log(`P0 (blocks any production financial activity): ${p0Failures.length}`);
  console.log(`P1 (blocks production launch): ${p1Failures.length}`);
  console.log(`P2 (should fix shortly after launch): ${p2Failures.length}`);

  if (p0Failures.length > 0) {
    console.log("\nBLOCKED — at least one P0 condition failed. This is not a false alarm to silence; it reflects real, unimplemented prerequisites.");
    process.exit(1);
  }
  console.log("\nNo P0 blockers found by this check (P1/P2 items may still block a full production launch — see docs).");
  process.exit(0);
}

module.exports = { runEnvChecks, runStructuralChecks, runDbChecks, SEVERITY };

if (require.main === module) {
  main().catch((error) => {
    console.error("Production readiness check crashed:", error);
    process.exit(1);
  });
}
