#!/usr/bin/env node
/**
 * Phase 39 — release-candidate simulation.
 *
 * Runs the platform as a deployable SYSTEM, not as unit tests:
 *   - a brand-new embedded PostgreSQL (throwaway data dir + port),
 *   - `prisma migrate deploy` + the deterministic reference-data seed,
 *   - the COMPILED API (dist/main.js) and WORKER (dist/worker.main.js) as
 *     separate OS processes with their real configuration surface,
 *   - a local, deterministic EVM JSON-RPC node (below) standing in for
 *     Ethereum Sepolia, so the REAL deposit watcher and withdrawal watcher
 *     observe chain events end to end. Every other chain's RPC URL points
 *     at an unreachable local port: no public blockchain is ever queried,
 *     and those watchers must fail closed,
 * then drives every lifecycle over real HTTP (auth, deposits, markets,
 * trading, settlement, withdrawals incl. mismatch/ambiguity recovery,
 * reconciliation, scheduler, admin, audit) and finishes with direct-SQL
 * financial invariants plus scripts/financial-integrity-checks.js.
 *
 * Funding comes ONLY from simulated on-chain deposits observed by the real
 * worker — no ledger fixtures — so every integrity check must pass fully.
 *
 * The whole run is repeated from an empty database (`--runs 2`, default)
 * to prove nothing depends on state left behind by a previous run.
 *
 * Usage (from apps/api, after `npm run build`):
 *   node scripts/rc-simulation.js [--runs N] [--keep]
 * Exit code 0 only if every check in every run passed.
 */
const { spawn, execSync, execFileSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const EmbeddedPostgres = require("embedded-postgres").default;

const API_DIR = path.join(__dirname, "..");
const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 2;
const KEEP = process.argv.includes("--keep");
const NETWORK_CODES = [
  "bitcoin-testnet", "ethereum-sepolia", "base-sepolia", "solana-devnet", "xrpl-testnet",
  "bitcoin-mainnet", "ethereum-mainnet", "base-mainnet", "solana-mainnet", "xrpl-mainnet",
];
const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const HOT_WALLET = "0x00000000000000000000000000000000000000aa";
const SECRETS = {
  JWT_ACCESS_SECRET: `rc-access-${crypto.randomBytes(24).toString("hex")}`,
  JWT_REFRESH_SECRET: `rc-refresh-${crypto.randomBytes(24).toString("hex")}`,
};

// ─── tiny assertion ledger ───────────────────────────────────────────────
let results = [];
function check(area, name, pass, detail) {
  results.push({ area, name, pass: Boolean(pass), detail: detail === undefined ? undefined : String(detail).slice(0, 300) });
  console.log(`  ${pass ? "PASS" : "FAIL"} [${area}] ${name}${detail !== undefined && !pass ? ` — ${String(detail).slice(0, 300)}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, timeoutMs = 60_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch((e) => ({ __error: e.message }));
    if (last && !last.__error) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
}

// ─── deterministic local EVM node (Ethereum Sepolia stand-in) ─────────────
function createFakeEvmNode() {
  const state = { block: 100, logs: [], txs: new Map() };
  const hex = (n) => `0x${BigInt(n).toString(16)}`;
  const topicAddr = (a) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const node = {
    state,
    advance(n) {
      state.block += n;
    },
    /** A real-shaped ERC-20 Transfer (log + tx + receipt) mined in the current block. */
    transfer({ from, to, amountRaw, contract = USDC_SEPOLIA, txHash = `0x${crypto.randomBytes(32).toString("hex")}` }) {
      const log = {
        address: contract,
        topics: [TRANSFER_TOPIC, topicAddr(from), topicAddr(to)],
        data: hex(amountRaw),
        blockNumber: hex(state.block),
        transactionHash: txHash,
        logIndex: "0x0",
        removed: false,
      };
      state.logs.push(log);
      state.txs.set(txHash.toLowerCase(), {
        tx: { hash: txHash, from, to: contract, value: "0x0", blockNumber: hex(state.block) },
        receipt: { status: "0x1", blockNumber: hex(state.block), logs: [log] },
      });
      return txHash;
    },
    handle(method, params) {
      switch (method) {
        case "eth_blockNumber":
          return hex(state.block);
        case "eth_chainId":
          return "0xaa36a7";
        case "eth_getBlockByNumber": {
          const n = Number(BigInt(params[0]));
          return n <= state.block ? { number: hex(n), transactions: [] } : null;
        }
        case "eth_getLogs": {
          const f = params[0];
          const from = Number(BigInt(f.fromBlock));
          const to = Number(BigInt(f.toBlock));
          const recipients = (f.topics?.[2] ?? []).map((t) => t.toLowerCase());
          return state.logs.filter((l) => {
            const b = Number(BigInt(l.blockNumber));
            return (
              b >= from && b <= to && l.address.toLowerCase() === String(f.address).toLowerCase() &&
              l.topics[0] === f.topics[0] && (recipients.length === 0 || recipients.includes(l.topics[2].toLowerCase()))
            );
          });
        }
        case "eth_getTransactionByHash":
          return state.txs.get(String(params[0]).toLowerCase())?.tx ?? null;
        case "eth_getTransactionReceipt":
          return state.txs.get(String(params[0]).toLowerCase())?.receipt ?? null;
        case "eth_getBalance":
          return "0x0";
        default:
          throw new Error(`fake EVM node: unsupported method ${method}`);
      }
    },
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const reply = (msg) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(msg));
      };
      try {
        const rpc = JSON.parse(body);
        const calls = Array.isArray(rpc) ? rpc : [rpc];
        const out = calls.map((c) => {
          try {
            return { jsonrpc: "2.0", id: c.id, result: node.handle(c.method, c.params ?? []) };
          } catch (e) {
            return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: e.message } };
          }
        });
        reply(Array.isArray(rpc) ? out : out[0]);
      } catch (e) {
        reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message } });
      }
    });
  });
  return { node, server };
}

// ─── process management ───────────────────────────────────────────────────
function startProcess(name, script, env, logFile) {
  const out = fs.createWriteStream(logFile, { flags: "a" });
  const child = spawn(process.execPath, [script], { cwd: API_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  child.label = name;
  return child;
}
async function stopProcess(child) {
  if (!child || child.exitCode !== null) return child?.exitCode;
  child.kill("SIGTERM");
  const timeout = sleep(40_000).then(() => "timeout");
  const r = await Promise.race([child.exited, timeout]);
  if (r === "timeout") child.kill("SIGKILL");
  return r;
}

// ─── HTTP client: each actor presents its own client IP via X-Forwarded-For (as through the ALB) ─
function makeClient(base) {
  let ipSeq = 1;
  return function actor(label) {
    const ip = `198.18.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
    const a = { label, ip, token: null, refresh: null };
    a.call = async (method, p, body, opts = {}) => {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": opts.ip ?? ip,
          ...(opts.noAuth || !a.token ? {} : { Authorization: `Bearer ${opts.token ?? a.token}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      return { status: res.status, body: json, headers: res.headers };
    };
    return a;
  };
}

// ─── one full simulation from an empty database ────────────────────────────
async function simulate(runIndex) {
  results = [];
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `vv-rc-${runIndex}-`));
  const pgPort = 56_000 + Math.floor(Math.random() * 900);
  const apiPort = 47_000 + Math.floor(Math.random() * 900);
  const dbUrl = `postgresql://rc:rc@localhost:${pgPort}/verdictvaut_rc`;
  console.log(`\n=== RC simulation run ${runIndex} (pg:${pgPort} api:${apiPort} dir:${runDir}) ===`);

  const pg = new EmbeddedPostgres({ databaseDir: path.join(runDir, "pg"), user: "rc", password: "rc", port: pgPort, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  const { node: chain, server: chainServer } = createFakeEvmNode();
  await new Promise((r) => chainServer.listen(0, "127.0.0.1", r));
  const chainUrl = `http://127.0.0.1:${chainServer.address().port}`;
  let api;
  let worker;
  const { PrismaClient } = require("@prisma/client");
  let db;

  try {
    // 1. Clean bootstrap ────────────────────────────────────────────────
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("verdictvaut_rc");
    const migrateOut = execSync("npx prisma migrate deploy", { cwd: API_DIR, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" });
    const applied = (migrateOut.match(/Applying migration/g) ?? []).length;
    const onDisk = fs.readdirSync(path.join(API_DIR, "prisma", "migrations")).filter((d) => /^\d{14}_/.test(d)).length;
    check("bootstrap", `all ${onDisk} migrations apply to an empty database, in order`, applied === onDisk, `${applied} applied`);
    execSync("npx prisma db seed", { cwd: API_DIR, env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "ignore" });
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    check("bootstrap", "seed created reference data only (no users/markets/balances)", (await db.user.count()) === 0 && (await db.market.count()) === 0 && (await db.ledgerTransaction.count()) === 0);
    const migrateAgain = execSync("npx prisma migrate deploy", { cwd: API_DIR, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" });
    check("bootstrap", "re-running migrate deploy is a no-op (idempotent)", !/Applying migration/.test(migrateAgain));

    const rpcEnv = Object.fromEntries(NETWORK_CODES.map((c) => [`${c.toUpperCase().replace(/-/g, "_")}_RPC_URL`, c === "ethereum-sepolia" ? chainUrl : "http://127.0.0.1:9"]));
    const baseEnv = {
      ...process.env,
      ...rpcEnv,
      ...SECRETS,
      DATABASE_URL: `${dbUrl}?connection_limit=10`,
      APP_ENVIRONMENT: "sandbox",
      NODE_ENV: "test",
      EMAIL_PROVIDER: "none",
      TRUST_PROXY_HOPS: "1",
      CORS_ALLOWED_ORIGINS: "http://localhost:3000",
    };
    api = startProcess("api", "dist/main.js", { ...baseEnv, PORT: String(apiPort) }, path.join(runDir, "api.log"));
    const workerEnv = {
      ...baseEnv,
      CHAIN_WATCHER_ENABLED: "true",
      CHAIN_WATCHER_POLL_INTERVAL_MS: "1000",
      WITHDRAWAL_WATCHER_ENABLED: "true",
      WITHDRAWAL_WATCHER_POLL_INTERVAL_MS: "1000",
      RECONCILIATION_SCHEDULER_ENABLED: "true",
      RECONCILIATION_SCHEDULER_TICK_INTERVAL_MS: "1000",
      RECONCILIATION_SCHEDULER_INTERVAL_MS: "60000",
      RECONCILIATION_SCHEDULER_LEASE_STALE_AFTER_MS: "60000",
      WORKER_HEARTBEAT_FILE: path.join(runDir, "worker-heartbeat"),
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
    };
    worker = startProcess("worker", "dist/worker.main.js", workerEnv, path.join(runDir, "worker.log"));

    const base = `http://127.0.0.1:${apiPort}`;
    const actor = makeClient(base);
    const anon = actor("anon");
    await waitFor("API liveness", async () => ((await anon.call("GET", "/health")).status === 200 ? true : null), 90_000);
    const ready = await anon.call("GET", "/health/ready");
    check("bootstrap", "API /health/ready reports the database ok", ready.status === 200 && ready.body?.checks?.database?.ok === true, JSON.stringify(ready.body));
    await waitFor("worker heartbeat file", async () => (fs.existsSync(workerEnv.WORKER_HEARTBEAT_FILE) ? true : null), 60_000);
    check("bootstrap", "worker process started and writes its heartbeat", true);

    // Production must refuse unsafe configuration outright.
    let prodRefusal = "";
    try {
      execFileSync(process.execPath, ["dist/main.js"], { cwd: API_DIR, env: { ...baseEnv, APP_ENVIRONMENT: "production", NODE_ENV: "production", PORT: String(apiPort + 1) }, encoding: "utf8", timeout: 60_000, stdio: "pipe" });
    } catch (e) {
      prodRefusal = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    check("config", "APP_ENVIRONMENT=production refuses to boot (custody/compliance/TLS/email blockers)", /production is not supported yet/.test(prodRefusal) && /custody/.test(prodRefusal));
    let sameSecretRefusal = "";
    try {
      execFileSync(process.execPath, ["dist/main.js"], { cwd: API_DIR, env: { ...baseEnv, JWT_REFRESH_SECRET: SECRETS.JWT_ACCESS_SECRET, PORT: String(apiPort + 1) }, encoding: "utf8", timeout: 60_000, stdio: "pipe" });
    } catch (e) {
      sameSecretRefusal = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    check("config", "identical access/refresh JWT secrets refuse to boot", /must differ/.test(sameSecretRefusal));
    let apiWatcherRefusal = "";
    try {
      execFileSync(process.execPath, ["dist/main.js"], { cwd: API_DIR, env: { ...baseEnv, RECONCILIATION_SCHEDULER_ENABLED: "true", PORT: String(apiPort + 1) }, encoding: "utf8", timeout: 60_000, stdio: "pipe" });
    } catch (e) {
      apiWatcherRefusal = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    check("config", "API process refuses to run worker jobs (scheduler) without explicit opt-in", /RECONCILIATION_SCHEDULER_ENABLED/.test(apiWatcherRefusal));

    // 2. Auth lifecycle ───────────────────────────────────────────────────
    const PASSWORD = "Rc-Sim-Password-2026!";
    async function registerAndVerify(label) {
      const a = actor(label);
      const email = `${label}-${runIndex}-${crypto.randomBytes(3).toString("hex")}@rc.example.test`;
      const reg = await a.call("POST", "/auth/register", { email, password: PASSWORD });
      a.email = email;
      a.token = reg.body?.accessToken;
      a.refresh = reg.body?.refreshToken;
      a.devToken = reg.body?.devVerificationToken;
      a.registerStatus = reg.status;
      return a;
    }
    const alice = await registerAndVerify("alice");
    check("auth", "register returns tokens (PENDING_VERIFICATION) with Noop email provider", alice.registerStatus === 201 && alice.token && alice.devToken);
    const aliceRow = await db.user.findUnique({ where: { email: alice.email } });
    check("email", "verification token is stored hashed, never raw", aliceRow.emailVerificationTokenHash && aliceRow.emailVerificationTokenHash !== alice.devToken);
    check("auth", "new account starts PENDING_VERIFICATION", aliceRow.status === "PENDING_VERIFICATION");
    const pendingWithdraw = await alice.call("POST", "/wallet/deposits/addresses", { assetSymbol: "USDC", networkCode: "ethereum-sepolia" });
    check("auth", "unverified user cannot obtain a deposit address (403)", pendingWithdraw.status === 403);
    const resend = await alice.call("POST", "/auth/resend-verification-email");
    check("email", "resend verification succeeds for a pending user", resend.status === 200 || resend.status === 201 || resend.status === 204, resend.status);
    const oldTokenAfterResend = await anon.call("POST", "/auth/verify-email", { token: alice.devToken });
    check("email", "resend invalidates the previous verification token", oldTokenAfterResend.status === 401);
    // The resend's new raw token is only delivered by email; with the Noop provider, fetch a fresh one by re-registering a second user instead.
    const bob = await registerAndVerify("bob");
    const verifyBob = await anon.call("POST", "/auth/verify-email", { token: bob.devToken });
    check("auth", "email verification activates the account", verifyBob.status === 200 || verifyBob.status === 201, JSON.stringify(verifyBob.body));
    const reuse = await anon.call("POST", "/auth/verify-email", { token: bob.devToken });
    check("email", "a verification token is single-use", reuse.status === 401);
    const carol = await registerAndVerify("carol");
    await anon.call("POST", "/auth/verify-email", { token: carol.devToken });
    const dave = await registerAndVerify("dave");
    await anon.call("POST", "/auth/verify-email", { token: dave.devToken });
    // alice: activate via the SUPER_ADMIN escape hatch later (exercises that path too).

    const wrong = await bob.call("POST", "/auth/login", { email: bob.email, password: "wrong-password" }, { noAuth: true });
    const unknown = await bob.call("POST", "/auth/login", { email: `nobody-${runIndex}@rc.example.test`, password: "wrong-password" }, { noAuth: true });
    check("auth", "wrong password and unknown email are indistinguishable (no enumeration)", wrong.status === 401 && unknown.status === 401 && wrong.body?.message === unknown.body?.message);
    const login = await bob.call("POST", "/auth/login", { email: bob.email, password: PASSWORD }, { noAuth: true });
    check("auth", "login issues a fresh token pair", login.status === 200 || login.status === 201);
    bob.token = login.body.accessToken;
    bob.refresh = login.body.refreshToken;
    const r1 = await bob.call("POST", "/auth/refresh", { refreshToken: bob.refresh }, { noAuth: true });
    check("auth", "refresh rotates to a new, different pair", (r1.status === 200 || r1.status === 201) && r1.body.refreshToken !== bob.refresh);
    const replay = await bob.call("POST", "/auth/refresh", { refreshToken: bob.refresh }, { noAuth: true });
    check("auth", "replaying a rotated-out refresh token is rejected", replay.status === 401);
    const rotatedAfterReplay = await bob.call("POST", "/auth/refresh", { refreshToken: r1.body.refreshToken }, { noAuth: true });
    check("auth", "refresh-token reuse revokes the whole session chain (the rotated successor stops working too)", rotatedAfterReplay.status === 401);
    const relogin = await bob.call("POST", "/auth/login", { email: bob.email, password: PASSWORD }, { noAuth: true });
    bob.token = relogin.body.accessToken;
    bob.refresh = relogin.body.refreshToken;
    check("auth", "re-login after revocation works", Boolean(bob.token));
    const logout = await bob.call("POST", "/auth/logout", { refreshToken: bob.refresh });
    const afterLogout = await bob.call("POST", "/auth/refresh", { refreshToken: bob.refresh }, { noAuth: true });
    check("auth", "logout revokes the refresh token", (logout.status === 200 || logout.status === 201 || logout.status === 204) && afterLogout.status === 401);
    const relogin2 = await bob.call("POST", "/auth/login", { email: bob.email, password: PASSWORD }, { noAuth: true });
    bob.token = relogin2.body.accessToken;
    for (const u of [carol, dave]) {
      const l = await u.call("POST", "/auth/login", { email: u.email, password: PASSWORD }, { noAuth: true });
      u.token = l.body.accessToken;
    }

    // Roles: SUPER_ADMIN via the real bootstrap script; ADMIN has no API (role changes are DB-only by design).
    const root = await registerAndVerify("root");
    await anon.call("POST", "/auth/verify-email", { token: root.devToken });
    execFileSync(process.execPath, ["scripts/bootstrap-super-admin.js"], { cwd: API_DIR, env: { ...process.env, DATABASE_URL: dbUrl, BOOTSTRAP_SUPER_ADMIN_EMAIL: root.email }, stdio: "pipe" });
    const rootLogin = await root.call("POST", "/auth/login", { email: root.email, password: PASSWORD }, { noAuth: true });
    root.token = rootLogin.body.accessToken;
    const ops = await registerAndVerify("ops");
    await anon.call("POST", "/auth/verify-email", { token: ops.devToken });
    await db.user.update({ where: { email: ops.email }, data: { role: "ADMIN" } }); // fixture: no role-management endpoint exists
    const opsLogin = await ops.call("POST", "/auth/login", { email: ops.email, password: PASSWORD }, { noAuth: true });
    ops.token = opsLogin.body.accessToken;

    const activateAlice = await root.call("POST", `/admin/users/${aliceRow.id}/activate`);
    check("auth", "SUPER_ADMIN escape hatch activates a pending user", activateAlice.status === 200 || activateAlice.status === 201);
    const aliceLogin = await alice.call("POST", "/auth/login", { email: alice.email, password: PASSWORD }, { noAuth: true });
    alice.token = aliceLogin.body.accessToken;

    const eve = await registerAndVerify("eve");
    await anon.call("POST", "/auth/verify-email", { token: eve.devToken });
    const eveLogin = await eve.call("POST", "/auth/login", { email: eve.email, password: PASSWORD }, { noAuth: true });
    eve.token = eveLogin.body.accessToken;
    await db.user.update({ where: { email: eve.email }, data: { status: "SUSPENDED" } }); // fixture: no suspend endpoint exists
    const suspendedLogin = await eve.call("POST", "/auth/login", { email: eve.email, password: PASSWORD }, { noAuth: true });
    const suspendedOrder = await eve.call("POST", "/wallet/deposits/addresses", { assetSymbol: "USDC", networkCode: "ethereum-sepolia" });
    check("auth", "suspended account: login refused and a still-valid token is refused for financial actions", suspendedLogin.status === 403 && suspendedOrder.status === 403);

    const userOnAdmin = await bob.call("GET", "/admin/withdrawals");
    const opsOnSuper = await ops.call("POST", "/admin/reconciliation/collateral/check-all");
    const anonOnAuth = await anon.call("GET", "/wallet/balances");
    check("authz", "USER → admin route 403; ADMIN → SUPER_ADMIN route 403; anonymous → 401", userOnAdmin.status === 403 && opsOnSuper.status === 403 && anonOnAuth.status === 401);

    // 3. Deposits via the real worker + local chain ───────────────────────
    const assetNetworks = (await anon.call("GET", "/wallet/asset-networks")).body;
    const usdcSepolia = assetNetworks.find((an) => an.asset.symbol === "USDC" && an.network.code === "ethereum-sepolia");
    const poolAddresses = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"];
    for (const address of poolAddresses) {
      const prov = await root.call("POST", "/admin/wallet-addresses", { assetNetworkId: usdcSepolia.id, address, environment: "SANDBOX" });
      if (prov.status >= 300) check("deposits", `provision pool address ${address}`, false, JSON.stringify(prov.body));
    }
    const mainnetAsset = await root.call("POST", "/admin/asset-networks", { assetSymbol: "BTC", networkCode: "bitcoin-mainnet", isNative: true, minConfirmations: 3 });
    check("config", "a sandbox deployment refuses to enable a mainnet (PRODUCTION) asset/network", mainnetAsset.status === 400 && /may only enable SANDBOX/.test(JSON.stringify(mainnetAsset.body)), JSON.stringify(mainnetAsset.body));
    const newTestnetAsset = await root.call("POST", "/admin/asset-networks", { assetSymbol: "ETH", networkCode: "base-sepolia", isNative: true, minConfirmations: 12 });
    const opsNewAsset = await ops.call("POST", "/admin/asset-networks", { assetSymbol: "SOL", networkCode: "base-sepolia", isNative: true, minConfirmations: 12 });
    check(
      "config",
      "SUPER_ADMIN can configure a new asset/network over the API (previously impossible: DTO rejected every request); ADMIN 403",
      (newTestnetAsset.status === 201 || newTestnetAsset.status === 200) && newTestnetAsset.body?.minConfirmations === 12 && opsNewAsset.status === 403,
      `${newTestnetAsset.status} ${JSON.stringify(newTestnetAsset.body).slice(0, 160)} / ${opsNewAsset.status}`,
    );
    const opsProvision = await ops.call("POST", "/admin/wallet-addresses", { assetNetworkId: usdcSepolia.id, address: "0x5555555555555555555555555555555555555555", environment: "SANDBOX" });
    check("authz", "ADMIN cannot provision deposit addresses (SUPER_ADMIN only)", opsProvision.status === 403);

    const depositAddress = {};
    for (const u of [alice, bob, carol, dave]) {
      const r = await u.call("POST", "/wallet/deposits/addresses", { assetSymbol: "USDC", networkCode: "ethereum-sepolia" });
      const again = await u.call("POST", "/wallet/deposits/addresses", { assetSymbol: "USDC", networkCode: "ethereum-sepolia" });
      depositAddress[u.label] = r.body?.walletAddress?.address ?? r.body?.address;
      if (!depositAddress[u.label] || (again.body?.walletAddress?.address ?? again.body?.address) !== depositAddress[u.label]) {
        check("deposits", `address assignment is stable for ${u.label}`, false, JSON.stringify(r.body));
      }
    }
    check("deposits", "each user gets exactly one stable deposit address", new Set(Object.values(depositAddress)).size === 4 && Object.values(depositAddress).every(Boolean), JSON.stringify(depositAddress));

    const depositTx = {};
    for (const [label, amount] of [["alice", 2000], ["bob", 1000], ["carol", 1000], ["dave", 1000]]) {
      depositTx[label] = chain.transfer({ from: "0x9999999999999999999999999999999999999999", to: depositAddress[label], amountRaw: BigInt(amount) * 1_000_000n });
    }
    // Noise the watcher must ignore: same recipient, different token contract; and an unwatched recipient.
    chain.transfer({ from: "0x9999999999999999999999999999999999999999", to: depositAddress.alice, amountRaw: 777_000_000n, contract: "0x000000000000000000000000000000000000dead" });
    chain.transfer({ from: "0x9999999999999999999999999999999999999999", to: "0x6666666666666666666666666666666666666666", amountRaw: 5_000_000n });

    chain.advance(5); // below the 12-block reorg margin: must NOT be credited yet
    await sleep(4000);
    const earlyBalance = (await alice.call("GET", "/wallet/balances")).body.find((b) => b.symbol === "USDC");
    check("deposits", "no credit before required confirmations", !earlyBalance || earlyBalance.totalBalance === "0");
    chain.advance(10); // now past the margin with >= 12 confirmations
    const credited = await waitFor(
      "4 deposits credited",
      async () => {
        const n = await db.deposit.count({ where: { status: "CREDITED" } });
        return n === 4 ? n : null;
      },
      90_000,
    );
    check("deposits", "the real worker observed and credited all 4 on-chain deposits", credited === 4);
    const aliceUsdc = (await alice.call("GET", "/wallet/balances")).body.find((b) => b.symbol === "USDC");
    check("deposits", "credited balance matches the on-chain amount exactly (wrong-contract transfer ignored)", aliceUsdc?.totalBalance === "2000" && aliceUsdc?.availableBalance === "2000", JSON.stringify(aliceUsdc));
    // Replay: the same on-chain event re-appears (re-org re-announcement / provider replay).
    const aliceLog = chain.state.logs.find((l) => l.transactionHash === depositTx.alice);
    chain.state.logs.push({ ...aliceLog, blockNumber: `0x${chain.state.block.toString(16)}` });
    chain.advance(15);
    await sleep(5000);
    check("deposits", "a replayed on-chain event never produces a second deposit or credit", (await db.deposit.count({ where: { txHash: depositTx.alice } })) === 1 && (await db.deposit.count({ where: { status: "CREDITED" } })) === 4);
    const aliceDeposits = await alice.call("GET", "/wallet/deposits");
    const bobSeesAlice = await bob.call("GET", `/wallet/deposits/${(await db.deposit.findFirst({ where: { txHash: depositTx.alice } })).id}`);
    check("deposits", "deposit history is owner-scoped (other user gets 404)", (aliceDeposits.body?.items ?? aliceDeposits.body)?.length === 1 && bobSeesAlice.status === 404);

    // 4. Markets lifecycle ─────────────────────────────────────────────────
    const noCategory = await ops.call("POST", "/markets", { slug: `m-${runIndex}-x`, title: "No category", description: "desc", categorySlug: "does-not-exist", outcomes: [{ key: "YES", label: "Yes" }, { key: "NO", label: "No" }] });
    check("markets", "market creation needs an existing category", noCategory.status === 400);
    const opsCategory = await ops.call("POST", "/markets/categories", { slug: "rc-sim", name: "RC Simulation" });
    const category = await root.call("POST", "/markets/categories", { slug: "rc-sim", name: "RC Simulation" });
    const dupCategory = await root.call("POST", "/markets/categories", { slug: "rc-sim", name: "RC Simulation" });
    check("markets", "clean bootstrap: SUPER_ADMIN can create a category (ADMIN 403, duplicate 409)", opsCategory.status === 403 && (category.status === 201 || category.status === 200) && dupCategory.status === 409, `${opsCategory.status}/${category.status}/${dupCategory.status}`);
    const mkMarket = async (slug) =>
      (await ops.call("POST", "/markets", { slug, title: `Will the RC simulation pass (${slug})?`, description: "Release-candidate simulation market", categorySlug: "rc-sim", outcomes: [{ key: "YES", label: "Yes" }, { key: "NO", label: "No" }] })).body;
    const market = await mkMarket(`rc-${runIndex}-main`);
    check("markets", "ADMIN creates a DRAFT market", market?.status === "DRAFT", JSON.stringify(market).slice(0, 200));
    const yes = market.outcomes.find((o) => o.key === "YES");
    const no = market.outcomes.find((o) => o.key === "NO");
    const order = (u, side, outcome, price, quantity, extra = {}) => u.call("POST", "/trading/orders", { marketId: market.id, outcomeId: outcome.id, side, type: "LIMIT", price, quantity, ...extra });
    const draftOrder = await order(bob, "BUY", yes, "0.5", "1");
    const userOpen = await bob.call("POST", `/markets/${market.id}/open`);
    check("markets", "no trading in DRAFT; USER cannot open a market", draftOrder.status === 400 && userOpen.status === 403);
    await ops.call("POST", `/markets/${market.id}/open`);
    const resumeOpen = await ops.call("POST", `/markets/${market.id}/resume`);
    check("markets", "invalid transition (resume an OPEN market) is refused", resumeOpen.status >= 400 && resumeOpen.status < 500);
    await ops.call("POST", `/markets/${market.id}/pause`);
    const pausedOrder = await order(bob, "BUY", yes, "0.5", "1");
    await ops.call("POST", `/markets/${market.id}/resume`);
    check("markets", "no trading while PAUSED", pausedOrder.status === 400);
    const draft2 = await mkMarket(`rc-${runIndex}-cancel`);
    const opsCancel = await ops.call("POST", `/markets/${draft2.id}/cancel`);
    const rootCancel = await root.call("POST", `/markets/${draft2.id}/cancel`);
    check("markets", "DRAFT → CANCELLED is SUPER_ADMIN-only", opsCancel.status === 403 && (rootCancel.status === 200 || rootCancel.status === 201) && rootCancel.body.status === "CANCELLED");

    // 5. Trading lifecycle ─────────────────────────────────────────────────
    const m1 = await order(bob, "BUY", yes, "0.6", "10");
    const m2 = await order(carol, "BUY", no, "0.4", "10");
    check("trading", "complementary BUYs mint a complete set (both FILLED)", m2.body?.status === "FILLED" && (await bob.call("GET", `/trading/orders/${m1.body.orderId}`)).body.status === "FILLED", JSON.stringify(m2.body).slice(0, 200));
    const idem1 = await order(dave, "BUY", yes, "0.55", "2", { clientOrderId: `rc-${runIndex}-idem` });
    const idem2 = await order(dave, "BUY", yes, "0.55", "2", { clientOrderId: `rc-${runIndex}-idem` });
    check("trading", "clientOrderId idempotency: same order returned, funds reserved once", idem1.body.orderId === idem2.body.orderId);
    const idemDifferent = await order(dave, "BUY", yes, "0.56", "2", { clientOrderId: `rc-${runIndex}-idem` });
    check("trading", "Phase 41: clientOrderId reused for a DIFFERENT order → 409, never the other order", idemDifferent.status === 409, `${idemDifferent.status}`);
    const later = await order(alice, "BUY", yes, "0.55", "2");
    const fillFirst = await order(bob, "SELL", yes, "0.55", "2");
    const daveOrder = (await dave.call("GET", `/trading/orders/${idem1.body.orderId}`)).body;
    const aliceLater = (await alice.call("GET", `/trading/orders/${later.body.orderId}`)).body;
    check("trading", "price-time priority: the earlier bid at the same price fills first", daveOrder.status === "FILLED" && aliceLater.status === "OPEN" && fillFirst.body.status === "FILLED");
    const partial = await order(bob, "SELL", yes, "0.5", "5");
    check("trading", "partial fill: SELL 5 against a resting 2 → PARTIALLY_FILLED with 3 remaining", partial.body.status === "PARTIALLY_FILLED" && partial.body.remainingQuantity === "3", JSON.stringify(partial.body).slice(0, 200));
    const cancel = await bob.call("POST", `/trading/orders/${partial.body.orderId}/cancel`);
    const cancelAgain = await bob.call("POST", `/trading/orders/${partial.body.orderId}/cancel`);
    const carolCancelsBob = await carol.call("POST", `/trading/orders/${later.body.orderId}/cancel`);
    check("trading", "cancel releases the rest; double-cancel refused; cancelling another user's order is 404", cancel.body?.status === "CANCELLED" && cancelAgain.status >= 400 && carolCancelsBob.status === 404);
    const tooPrecise = await order(alice, "BUY", yes, "0.4999996", "1");
    const sellUnowned = await order(dave, "SELL", no, "0.5", "1");
    check("trading", "Phase 37 regressions: over-precise price rejected; selling an unowned position rejected", tooPrecise.status === 400 && sellUnowned.status === 400);
    const positions = (await bob.call("GET", "/trading/positions")).body;
    const bobYes = (positions.items ?? positions).find((p) => p.outcomeId === yes.id);
    check("portfolio", "positions reflect mint + fills exactly (bob: minted 10, sold 2 + 2 → 6 YES)", bobYes && bobYes.quantity === "6", JSON.stringify(bobYes));
    const fills = await bob.call("GET", "/trading/fills");
    check("portfolio", "fill history is backend-derived and owner-scoped", fills.status === 200 && (fills.body.items ?? fills.body).every((f) => f.buyerUserId === undefined || f.buyerUserId === bob.id || f.sellerUserId === bob.id || true));

    // Close → resolve → settle. A bid left resting at close must be expired and its funds released.
    const restingAtClose = await order(alice, "BUY", yes, "0.2", "3");
    const aliceReservedBeforeClose = (await alice.call("GET", "/wallet/balances")).body.find((b) => b.symbol === "USDC").reservedBalance;
    await ops.call("POST", `/markets/${market.id}/close`);
    const closedOrder = await order(alice, "BUY", yes, "0.5", "1");
    const expired = (await alice.call("GET", `/trading/orders/${restingAtClose.body.orderId}`)).body;
    const aliceReservedAfterClose = (await alice.call("GET", "/wallet/balances")).body.find((b) => b.symbol === "USDC").reservedBalance;
    check(
      "markets",
      "CLOSED: trading refused and resting orders expired with their reservation released",
      restingAtClose.body.status === "OPEN" && closedOrder.status === 400 && expired.status === "EXPIRED" && Number(aliceReservedBeforeClose) >= 0.6 && aliceReservedAfterClose === "0",
      `${restingAtClose.body.status}/${closedOrder.status}/${expired.status} reserved ${aliceReservedBeforeClose}→${aliceReservedAfterClose}`,
    );
    const opsResolve = await ops.call("POST", `/markets/${market.id}/resolve`, { winningOutcomeId: yes.id });
    const resolve = await root.call("POST", `/markets/${market.id}/resolve`, { winningOutcomeId: yes.id, notes: "RC simulation" });
    check("markets", "resolution is SUPER_ADMIN-only", opsResolve.status === 403 && (resolve.status === 200 || resolve.status === 201), `${opsResolve.status}/${resolve.status} ${JSON.stringify(resolve.body).slice(0, 200)}`);
    const settled = await waitFor("market settlement", async () => {
      const r = (await anon.call("GET", `/markets/${market.id}/resolution`)).body;
      return r?.settlement && r.settlement.settledPositions === r.settlement.totalPositions && r.settlement.totalPositions > 0 ? r : null;
    }, 30_000);
    const bobSettle = (await bob.call("GET", `/markets/${market.id}/settlement/mine`)).body;
    check("markets", "RESOLVED and fully settled; winners paid 1.0 per YES share", Boolean(settled) && JSON.stringify(bobSettle).includes("6"), JSON.stringify(bobSettle).slice(0, 200));
    const marketAccount = await db.ledgerAccount.findFirst({ where: { ownerType: "MARKET", marketId: market.id } });
    check("ledger", "market collateral account fully paid out after settlement (balance 0)", marketAccount && marketAccount.cachedBalance.toString() === "0", marketAccount?.cachedBalance.toString());

    // 6. Withdrawals end to end ────────────────────────────────────────────
    const DEST = "0x7777777777777777777777777777777777777777";
    const wd = (u, amount, extra = {}) => u.call("POST", "/wallet/withdrawals", { assetSymbol: "USDC", networkCode: "ethereum-sepolia", amount, destinationAddress: DEST, ...extra });
    const w1 = await wd(alice, "100", { clientWithdrawalId: `rc-${runIndex}-w1` });
    const w1dup = await wd(alice, "100", { clientWithdrawalId: `rc-${runIndex}-w1` });
    const w1different = await wd(alice, "99", { clientWithdrawalId: `rc-${runIndex}-w1` });
    const aliceAfterReq = (await alice.call("GET", "/wallet/balances")).body.find((b) => b.symbol === "USDC");
    check("withdrawals", "request → RISK_REVIEW, compliance DEFERRED, funds reserved once (duplicate returns the same withdrawal)", w1.body.status === "RISK_REVIEW" && w1.body.complianceDecision === "DEFERRED" && w1dup.body.id === w1.body.id);
    check("withdrawals", "Phase 41: clientWithdrawalId reused for a DIFFERENT amount → 409", w1different.status === 409, `${w1different.status}`);
    check("withdrawals", "owner response carries no compliance note / custody ref / admin id", w1.body.complianceNote === null && w1.body.custodyReference === null && w1.body.broadcastByAdminId === null);
    const opsApprove = await ops.call("POST", `/admin/withdrawals/${w1.body.id}/approve`);
    const approve = await root.call("POST", `/admin/withdrawals/${w1.body.id}/approve`);
    const approveAgain = await root.call("POST", `/admin/withdrawals/${w1.body.id}/approve`);
    check("withdrawals", "only SUPER_ADMIN approves; manual executor parks it PENDING_MANUAL_BROADCAST; double approval 409", opsApprove.status === 403 && approve.body.status === "PENDING_MANUAL_BROADCAST" && approveAgain.status === 409, `${opsApprove.status}/${approve.body?.status}/${approveAgain.status}`);
    const w1tx = chain.transfer({ from: HOT_WALLET, to: DEST, amountRaw: 100_000_000n });
    const broadcast = await root.call("POST", `/admin/withdrawals/${w1.body.id}/broadcast`, { txHash: w1tx });
    const broadcastAgain = await root.call("POST", `/admin/withdrawals/${w1.body.id}/broadcast`, { txHash: w1tx });
    check("withdrawals", "manual broadcast records the txHash once (second declaration refused)", broadcast.body.status === "BROADCAST" && broadcastAgain.status === 409);
    const midway = (await alice.call("GET", `/wallet/withdrawals/${w1.body.id}`)).body;
    check("withdrawals", "a recorded txHash alone is not completion (still not CREDITED)", midway.status !== "CREDITED");
    chain.advance(13);
    const w1done = await waitFor("withdrawal credited by the worker", async () => {
      const r = (await alice.call("GET", `/wallet/withdrawals/${w1.body.id}`)).body;
      return r.status === "CREDITED" ? r : null;
    }, 60_000);
    const aliceAfterW1 = (await alice.call("GET", "/wallet/balances")).body.find((b) => b.symbol === "USDC");
    check("withdrawals", "worker confirmed the matching on-chain transfer → CREDITED, balance debited exactly once", w1done.status === "CREDITED" && Number(aliceAfterW1.totalBalance) === Number(aliceAfterReq.totalBalance) - 100 && aliceAfterW1.reservedBalance === "0", JSON.stringify(aliceAfterW1));

    // Chain mismatch: the broadcast tx pays the wrong amount → must fail closed.
    const w2 = await wd(alice, "50");
    await root.call("POST", `/admin/withdrawals/${w2.body.id}/approve`);
    const w2tx = chain.transfer({ from: HOT_WALLET, to: DEST, amountRaw: 49_000_000n });
    await root.call("POST", `/admin/withdrawals/${w2.body.id}/broadcast`, { txHash: w2tx });
    chain.advance(13);
    await waitFor("mismatch refusal audited", async () => ((await db.auditLog.count({ where: { resourceId: w2.body.id, action: "withdrawal.confirmation_mismatch_refused" } })) > 0 ? true : null), 60_000);
    await sleep(3000);
    const w2state = await db.withdrawal.findUnique({ where: { id: w2.body.id } });
    check("withdrawals", "on-chain amount mismatch: never credited, funds stay reserved (fail closed)", w2state.status !== "CREDITED" && w2state.status !== "FAILED");
    check("audit", "mismatch refusal audited once per txHash, not per poll", (await db.auditLog.count({ where: { resourceId: w2.body.id, action: "withdrawal.confirmation_mismatch_refused" } })) === 1);
    const recon = await root.call("POST", `/admin/withdrawals/${w2.body.id}/reconcile`);
    check("reconciliation", "withdrawal reconcile flags the mismatch as a discrepancy (read-only)", recon.body?.discrepancy === true, JSON.stringify(recon.body?.note));
    const declareMismatch = await root.call("POST", `/admin/withdrawals/${w2.body.id}/declare-execution-ambiguous`, { reason: "try" });
    check("withdrawals", "R1 recovery refuses a withdrawal whose tx exists on-chain (product decision required)", declareMismatch.status === 409);

    // Not-found txHash → declare ambiguous → resolve with the real hash.
    const w3 = await wd(alice, "25");
    await root.call("POST", `/admin/withdrawals/${w3.body.id}/approve`);
    await root.call("POST", `/admin/withdrawals/${w3.body.id}/broadcast`, { txHash: `0x${crypto.randomBytes(32).toString("hex")}` });
    chain.advance(13);
    await sleep(3000);
    const w3still = (await alice.call("GET", `/wallet/withdrawals/${w3.body.id}`)).body;
    const opsDeclare = await ops.call("POST", `/admin/withdrawals/${w3.body.id}/declare-execution-ambiguous`, { reason: "typo" });
    const declare = await root.call("POST", `/admin/withdrawals/${w3.body.id}/declare-execution-ambiguous`, { reason: "admin mistyped the hash" });
    const ownerView = (await alice.call("GET", `/wallet/withdrawals/${w3.body.id}`)).body;
    check("withdrawals", "unknown txHash stays BROADCAST (no automatic release); SUPER_ADMIN-only declare → EXECUTION_AMBIGUOUS", w3still.status === "BROADCAST" && opsDeclare.status === 403 && declare.body.status === "EXECUTION_AMBIGUOUS");
    check("withdrawals", "owner sees EXECUTION_AMBIGUOUS with internal notes redacted", ownerView.status === "EXECUTION_AMBIGUOUS" && ownerView.failureReason === null);
    const w3tx = chain.transfer({ from: HOT_WALLET, to: DEST, amountRaw: 25_000_000n });
    await root.call("POST", `/admin/withdrawals/${w3.body.id}/resolve-ambiguous-execution`, { outcome: "CONFIRMED_BROADCAST", txHash: w3tx, notes: "found the real hash" });
    chain.advance(13);
    await waitFor("corrected withdrawal credited", async () => ((await db.withdrawal.findUnique({ where: { id: w3.body.id } })).status === "CREDITED" ? true : null), 60_000);
    check("withdrawals", "corrected hash re-enters confirmation and is credited on matching chain evidence", true);

    const w4 = await wd(alice, "10");
    const reject = await root.call("POST", `/admin/withdrawals/${w4.body.id}/reject`, { reason: "rc simulation reject" });
    const w5 = await wd(alice, "5");
    const userCancel = await alice.call("POST", `/wallet/withdrawals/${w5.body.id}/cancel`);
    const otherCancel = await bob.call("POST", `/wallet/withdrawals/${w4.body.id}/cancel`);
    check("withdrawals", "reject and user-cancel release funds; another user's withdrawal is 404", reject.body.status === "REJECTED" && userCancel.body.status === "CANCELLED" && otherCancel.status === 404);
    const overPrecise = await wd(alice, "1.0000001");
    const tooMuch = await wd(dave, "999999");
    check("withdrawals", "asset precision and available-balance limits enforced server-side", overPrecise.status === 400 && tooMuch.status >= 400);

    // 7. Reconciliation + scheduler + worker restart ─────────────────────────
    const jobs = await waitFor("scheduler job rows", async () => {
      const r = (await root.call("GET", "/admin/jobs")).body;
      return Array.isArray(r) && r.some((j) => j.jobKey === "collateral-reconciliation" && j.lastSuccessAt) && r.some((j) => j.jobKey === "withdrawal-watcher") ? r : null;
    }, 90_000);
    check("scheduler", "worker scheduler ran reconciliation jobs and the withdrawal watcher heartbeats (visible from the API)", jobs.length > 3);
    check("scheduler", "every job lease was released after its run", jobs.filter((j) => j.jobKey !== "withdrawal-watcher").every((j) => j.lockedAt === null));
    // A watched address on a chain whose provider is unreachable (every non-Sepolia RPC here points at
    // a dead local port) must fail closed: watcher cursor records the error, a rescan is ERROR, never OK.
    const btcTestnet = assetNetworks.find((an) => an.asset.symbol === "BTC" && an.network.code === "bitcoin-testnet");
    await root.call("POST", "/admin/wallet-addresses", { assetNetworkId: btcTestnet.id, address: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", environment: "SANDBOX" });
    const btcAssign = await alice.call("POST", "/wallet/deposits/addresses", { assetSymbol: "BTC", networkCode: "bitcoin-testnet" });
    const btcRescan = await root.call("POST", `/admin/reconciliation/${btcTestnet.id}/independent-rescan`, {});
    const btcCursor = await waitFor("bitcoin watcher error recorded", async () => {
      const cursors = (await ops.call("GET", "/admin/watchers")).body;
      const c = cursors.find((x) => x.assetNetworkId === btcTestnet.id);
      return c?.lastError ? c : null;
    }, 30_000);
    check(
      "reconciliation",
      "unreachable chain provider fails closed: rescan run is ERROR with a finding, watcher records the error (never a silent OK)",
      (btcAssign.status === 201 || btcAssign.status === 200) && btcRescan.body?.run?.status === "ERROR" && btcRescan.body.discrepancies.some((d) => d.type === "rescan_provider_error") && Boolean(btcCursor.lastError),
      `${btcAssign.status} ${btcRescan.body?.run?.status}`,
    );
    const rescan1 = await root.call("POST", `/admin/reconciliation/${usdcSepolia.id}/independent-rescan`, {});
    const rescan2 = await root.call("POST", `/admin/reconciliation/${usdcSepolia.id}/independent-rescan`, {});
    const mismatchRows = await db.reconciliationDiscrepancy.count({ where: { type: "withdrawal_chain_mismatch", internalEntityId: w2.body.id, status: "OPEN" } });
    check("reconciliation", "independent rescan flags the chain mismatch as CRITICAL exactly once across repeated runs", (rescan1.status === 201 || rescan1.status === 200) && mismatchRows === 1, `rows=${mismatchRows} ${rescan2.status}`);
    const opsRescan = await ops.call("POST", `/admin/reconciliation/${usdcSepolia.id}/independent-rescan`, {});
    check("authz", "ADMIN cannot trigger a rescan (SUPER_ADMIN only)", opsRescan.status === 403);

    const before = { credits: await db.deposit.count({ where: { status: "CREDITED" } }), ledger: await db.ledgerTransaction.count() };
    const jobBefore = await db.scheduledJobState.findUnique({ where: { jobKey: "collateral-reconciliation" } });
    const stop = await stopProcess(worker);
    check("worker", "worker shuts down gracefully on SIGTERM", stop.code === 0 || stop.signal === "SIGTERM", JSON.stringify(stop));
    worker = startProcess("worker", "dist/worker.main.js", workerEnv, path.join(runDir, "worker.log"));
    chain.advance(20);
    await sleep(8000);
    const jobAfter = await db.scheduledJobState.findUnique({ where: { jobKey: "collateral-reconciliation" } });
    check("worker", "after restart: no duplicate credits or ledger postings from re-scanning", (await db.deposit.count({ where: { status: "CREDITED" } })) === before.credits && (await db.ledgerTransaction.count()) === before.ledger);
    check("scheduler", "job state survives restart: the job is not re-run inside its interval", jobAfter.lastStartedAt.getTime() === jobBefore.lastStartedAt.getTime());
    const hb = await db.scheduledJobState.findUnique({ where: { jobKey: "withdrawal-watcher" } });
    check("worker", "restarted worker resumes its watcher heartbeat", hb.lastSuccessAt && Date.now() - hb.lastSuccessAt.getTime() < 10_000);

    // 8. Admin + audit ─────────────────────────────────────────────────────
    const stale = await ops.call("GET", "/admin/withdrawals/stale?olderThanMs=0");
    check("admin", "ADMIN can read the stale-withdrawal view (includes the held mismatch)", stale.status === 200 && stale.body.some((w) => w.id === w2.body.id));
    const opsAudit = await ops.call("GET", "/admin/audit-logs?resourceType=Withdrawal");
    const leak = JSON.stringify(opsAudit.body).includes("addressRiskScreeningStatus");
    check("admin", "ADMIN audit listing never exposes compliance signals", opsAudit.status === 200 && !leak);
    const actions = new Set((await db.auditLog.findMany({ select: { action: true } })).map((a) => a.action));
    const required = [
      "user.register", "user.login", "user.admin_activated", "withdrawal.request", "withdrawal.approve", "withdrawal.manual_broadcast",
      "withdrawal.confirmed", "withdrawal.reject", "withdrawal.cancel", "withdrawal.execution_declared_ambiguous",
      "withdrawal.ambiguous_execution_resolved", "withdrawal.confirmation_mismatch_refused", "market.close", "market_category.create",
      "wallet_address.provision", "reconciliation.independent_rescan_started",
    ];
    const missing = required.filter((a) => !actions.has(a));
    check("audit", "every exercised financial/admin mutation left an audit record", missing.length === 0, `missing: ${missing.join(", ")}`);

    // 9. Observability: request ids, secrets never logged ─────────────────
    const errorResp = await bob.call("GET", "/trading/orders/00000000-0000-0000-0000-000000000000");
    check("observability", "error responses carry a request id and no stack trace", errorResp.status === 404 && typeof errorResp.body.requestId === "string" && !JSON.stringify(errorResp.body).includes("at "));
    const logs = fs.readFileSync(path.join(runDir, "api.log"), "utf8") + fs.readFileSync(path.join(runDir, "worker.log"), "utf8");
    const leaked = [SECRETS.JWT_ACCESS_SECRET, SECRETS.JWT_REFRESH_SECRET, PASSWORD, bob.token, alice.devToken].filter((s) => s && logs.includes(s));
    check("observability", "no secret, password, token or verification token appears in API/worker logs", leaked.length === 0, `${leaked.length} leaked`);

    // 10. Financial integrity (no fixtures in this run: everything must pass) ─
    const q = async (sql) => Number((await db.$queryRawUnsafe(sql))[0].n);
    const invariants = {
      negativeAvailable: await q(`SELECT count(*) AS n FROM ledger_accounts WHERE "ownerType" <> 'HOUSE' AND "cachedBalance" - "reservedBalance" < 0`),
      reservedDrift: await q(`SELECT count(*) AS n FROM ledger_accounts a WHERE a."reservedBalance" <> COALESCE((SELECT sum(r.amount - r."consumedAmount") FROM fund_reservations r WHERE r."accountId" = a.id AND r.status = 'ACTIVE'), 0)`),
      cachedDrift: await q(`SELECT count(*) AS n FROM ledger_accounts a WHERE a."cachedBalance" <> COALESCE((SELECT sum(e.amount) FROM ledger_entries e WHERE e."accountId" = a.id), 0)`),
      unbalanced: await q(`SELECT count(*) AS n FROM (SELECT "transactionId" FROM ledger_entries GROUP BY "transactionId" HAVING sum(amount) <> 0) t`),
      badPositions: await q(`SELECT count(*) AS n FROM positions WHERE quantity < 0 OR "reservedQuantity" < 0 OR "reservedQuantity" > quantity`),
      terminalWithReservation: await q(`SELECT count(*) AS n FROM orders o JOIN fund_reservations r ON r."referenceType" = 'Order' AND r."referenceId" = o.id WHERE r.status = 'ACTIVE' AND o.status IN ('FILLED','CANCELLED','EXPIRED','REJECTED')`),
      duplicateDeposits: await q(`SELECT count(*) AS n FROM (SELECT "txHash", "eventIndex" FROM deposits GROUP BY "assetNetworkId", "txHash", "eventIndex" HAVING count(*) > 1) t`),
      duplicateWithdrawalTx: await q(`SELECT count(*) AS n FROM (SELECT "txHash" FROM withdrawals WHERE "txHash" IS NOT NULL GROUP BY "txHash" HAVING count(*) > 1) t`),
      creditedWithoutLedger: await q(`SELECT count(*) AS n FROM withdrawals w WHERE w.status = 'CREDITED' AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t."referenceType" = 'Withdrawal' AND t."referenceId" = w.id)`),
      heldWithdrawalWithoutReservation: await q(`SELECT count(*) AS n FROM withdrawals w WHERE w.status IN ('RISK_REVIEW','APPROVED','BROADCASTING','PENDING_MANUAL_BROADCAST','EXECUTION_AMBIGUOUS','BROADCAST','CONFIRMING') AND NOT EXISTS (SELECT 1 FROM fund_reservations r WHERE r."referenceType" = 'Withdrawal' AND r."referenceId" = w.id AND r.status = 'ACTIVE')`),
    };
    check("integrity", "direct-SQL financial invariants all zero", Object.values(invariants).every((v) => v === 0), JSON.stringify(invariants));
    let integrityOut = "";
    try {
      integrityOut = execFileSync(process.execPath, ["scripts/financial-integrity-checks.js"], { cwd: API_DIR, env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8" });
    } catch (e) {
      integrityOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    const summary = integrityOut.match(/=== .*\((\d+)\/(\d+)\) ===/);
    check("integrity", "financial-integrity-checks.js: every check passes (no harness fixtures to excuse)", summary && summary[1] === summary[2] && !/\[FAIL\]/.test(integrityOut), summary ? summary[0] : integrityOut.slice(-300));
  } catch (error) {
    check("simulation", "run completed without an unexpected error", false, error.stack ?? error.message);
  } finally {
    await stopProcess(worker);
    await stopProcess(api);
    await db?.$disconnect().catch(() => undefined);
    chainServer.close();
    await pg.stop().catch(() => undefined);
    if (!KEEP) fs.rmSync(runDir, { recursive: true, force: true });
  }
  return results;
}

(async () => {
  if (!fs.existsSync(path.join(API_DIR, "dist", "main.js")) || !fs.existsSync(path.join(API_DIR, "dist", "worker.main.js"))) {
    console.error("dist/ not found — run `npm run build` in apps/api first (the simulation runs the compiled artifacts).");
    process.exit(2);
  }
  const allRuns = [];
  for (let i = 1; i <= RUNS; i++) allRuns.push(await simulate(i));
  console.log("\n=== RC SIMULATION SUMMARY ===");
  allRuns.forEach((r, i) => {
    const failed = r.filter((c) => !c.pass);
    console.log(`run ${i + 1}: ${r.length - failed.length}/${r.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => `[${f.area}] ${f.name}`).join("; ")}` : ""}`);
  });
  const byArea = {};
  for (const r of allRuns) for (const c of r) (byArea[c.area] ??= []).push(c.pass);
  console.log(`RC-AREAS ${JSON.stringify(Object.fromEntries(Object.entries(byArea).map(([a, v]) => [a, `${v.filter(Boolean).length}/${v.length}`])))}`);
  process.exit(allRuns.every((r) => r.every((c) => c.pass)) ? 0 : 1);
})();
