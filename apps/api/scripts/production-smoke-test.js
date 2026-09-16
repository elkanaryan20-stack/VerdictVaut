/**
 * Phase 29 — a production-SAFE operational smoke test: real HTTP
 * requests against a REAL running deployment (staging today; would work
 * identically against production once one exists), proving the
 * essential flows actually work end-to-end over the network — not
 * simulated, not mocked. Complements (never replaces) the real
 * integration test suite, which proves application logic against a
 * throwaway database, never a live HTTP stack.
 *
 * HARD SAFETY RULES, enforced by design, not just by convention:
 *   - Never places a real order. The order-validation check submits a
 *     DELIBERATELY invalid payload (a non-UUID marketId) and asserts a
 *     400 — proving validation works, never executing a trade.
 *   - Never submits a real withdrawal. Same pattern — a deliberately
 *     invalid payload (missing required fields), asserting 400.
 *   - Never creates a real user account. Registration is NOT exercised
 *     by this script at all — only login against an operator-supplied,
 *     already-existing test account (SMOKE_TEST_USER_EMAIL/PASSWORD),
 *     if those are provided; every check that needs an authenticated
 *     user is SKIPPED (not FAILED) if they are not.
 *   - Never fabricates a "successful transaction" — every write this
 *     script performs is a login (auth, not a financial action) and
 *     is expected to be REJECTED by validation/authorization; a 2xx
 *     response from an order/withdrawal-shaped request would be
 *     treated as a FAIL (an unexpectedly permissive endpoint), never
 *     as a success worth reporting.
 *   - Uses only Node's built-in `fetch` — no new dependency added.
 *
 * Usage:
 *   SMOKE_TEST_API_BASE_URL=https://staging.example.com \
 *   SMOKE_TEST_WEB_BASE_URL=https://staging-app.example.com \
 *   [SMOKE_TEST_USER_EMAIL=...] [SMOKE_TEST_USER_PASSWORD=...] \
 *   [SMOKE_TEST_ADMIN_TOKEN=...] \
 *     node scripts/production-smoke-test.js
 *
 * SMOKE_TEST_API_BASE_URL is the only required variable. Every other
 * variable's absence SKIPS the checks that need it — this script never
 * invents a test account or an admin token, and never fails merely
 * because an optional credential wasn't supplied.
 *
 * Exit code: 1 if any REQUIRED (non-skipped) check fails; 0 otherwise.
 */

const RESULTS = [];
function record(label, status, detail) {
  RESULTS.push({ label, status, detail });
  console.log(`  [${status}] ${label}${detail ? " — " + detail : ""}`);
}

async function request(baseUrl, requestPath, options = {}) {
  const url = `${baseUrl}${requestPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON body is fine for some endpoints; leave body null
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const apiBase = process.env.SMOKE_TEST_API_BASE_URL;
  const webBase = process.env.SMOKE_TEST_WEB_BASE_URL;
  const testEmail = process.env.SMOKE_TEST_USER_EMAIL;
  const testPassword = process.env.SMOKE_TEST_USER_PASSWORD;
  const adminToken = process.env.SMOKE_TEST_ADMIN_TOKEN;

  console.log("=== VerdictVaut production-safe operational smoke test (Phase 29) ===");
  console.log("Never places a real order, never submits a real withdrawal, never creates a real account.\n");

  if (!apiBase) {
    console.error("SMOKE_TEST_API_BASE_URL is required. Example: SMOKE_TEST_API_BASE_URL=https://staging.example.com node scripts/production-smoke-test.js");
    process.exitCode = 1;
    return;
  }

  // ── 1. Health endpoint ────────────────────────────────────────────
  try {
    const { status } = await request(apiBase, "/health");
    record("API liveness — GET /health", status === 200 ? "PASS" : "FAIL", `HTTP ${status}`);
  } catch (error) {
    record("API liveness — GET /health", "FAIL", error.message);
  }

  // ── 2. Readiness (DB connectivity) ──────────────────────────────────
  try {
    const { status } = await request(apiBase, "/health/ready");
    // 503 is a real, honest degraded signal, not a script bug — report
    // it as FAIL (this check exists specifically to catch that), never
    // silently pass a degraded database.
    record("API readiness (DB connectivity) — GET /health/ready", status === 200 ? "PASS" : "FAIL", `HTTP ${status}`);
  } catch (error) {
    record("API readiness (DB connectivity) — GET /health/ready", "FAIL", error.message);
  }

  // ── 3. Web availability (optional) ──────────────────────────────────
  if (webBase) {
    try {
      const { status } = await request(webBase, "/");
      record("Web availability — GET /", status === 200 ? "PASS" : "FAIL", `HTTP ${status}`);
    } catch (error) {
      record("Web availability — GET /", "FAIL", error.message);
    }
  } else {
    record("Web availability", "SKIPPED", "SMOKE_TEST_WEB_BASE_URL not set");
  }

  // ── 4. Market read access (public, unauthenticated) ─────────────────
  try {
    const { status, body } = await request(apiBase, "/markets");
    const looksReal = status === 200 && (Array.isArray(body) || Array.isArray(body?.data) || Array.isArray(body?.items));
    record("Public market read access — GET /markets", status === 200 ? "PASS" : "FAIL", `HTTP ${status}${status === 200 && !looksReal ? " (200 but response shape unexpected — verify manually)" : ""}`);
  } catch (error) {
    record("Public market read access — GET /markets", "FAIL", error.message);
  }

  // ── 5. Auth boundary — garbage credentials must be rejected ─────────
  try {
    const { status } = await request(apiBase, "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "smoke-test-nonexistent@example.invalid", password: "definitely-wrong-password" }),
    });
    record("Auth rejects invalid credentials — POST /auth/login (garbage)", status === 401 ? "PASS" : "FAIL", `HTTP ${status} (expected 401)`);
  } catch (error) {
    record("Auth rejects invalid credentials — POST /auth/login (garbage)", "FAIL", error.message);
  }

  // ── 6. Admin boundary — no token must be rejected ────────────────────
  try {
    const { status } = await request(apiBase, "/admin/watchers");
    record("Admin endpoint rejects unauthenticated access — GET /admin/watchers", status === 401 ? "PASS" : "FAIL", `HTTP ${status} (expected 401)`);
  } catch (error) {
    record("Admin endpoint rejects unauthenticated access — GET /admin/watchers", "FAIL", error.message);
  }

  // ── 7. Order validation boundary (never a real order) ────────────────
  // No auth token needed to prove this — JwtAuthGuard runs before the
  // DTO validation pipe, so an unauthenticated request to this route
  // is expected to be rejected at 401, which is itself the correct,
  // safe outcome and is what this check actually asserts; if a real
  // test-user token is available (§8 below) a deeper, authenticated
  // validation-boundary check is run there instead.
  try {
    const { status } = await request(apiBase, "/trading/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketId: "not-a-uuid", outcomeId: "not-a-uuid", side: "BUY", type: "LIMIT", quantity: "1" }),
    });
    const acceptable = status === 401 || status === 400;
    record("Order endpoint requires auth/validates input — POST /trading/orders (unauthenticated, malformed)", acceptable ? "PASS" : "FAIL", `HTTP ${status} (expected 400 or 401 — never 2xx)`);
    if (status >= 200 && status < 300) {
      record("SAFETY ALERT", "FAIL", "An intentionally-malformed, unauthenticated order request returned a 2xx status — this would mean a real order could be placed without a valid account. Investigate immediately.");
    }
  } catch (error) {
    record("Order endpoint requires auth/validates input — POST /trading/orders (unauthenticated, malformed)", "FAIL", error.message);
  }

  // ── 8. Authenticated checks (only if a real test account is supplied) ─
  let userToken = null;
  if (testEmail && testPassword) {
    try {
      const { status, body } = await request(apiBase, "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: testEmail, password: testPassword }),
      });
      if (status === 200 && body?.accessToken) {
        userToken = body.accessToken;
        record("Test-user login — POST /auth/login", "PASS", "authenticated successfully");
      } else {
        record("Test-user login — POST /auth/login", "FAIL", `HTTP ${status} — check SMOKE_TEST_USER_EMAIL/PASSWORD are correct and the account exists`);
      }
    } catch (error) {
      record("Test-user login — POST /auth/login", "FAIL", error.message);
    }
  } else {
    record("Test-user login", "SKIPPED", "SMOKE_TEST_USER_EMAIL/SMOKE_TEST_USER_PASSWORD not set — every check below that needs a real session is also skipped");
  }

  if (userToken) {
    const authHeaders = { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" };

    try {
      const { status, body } = await request(apiBase, "/users/me", { headers: authHeaders });
      record("Authenticated self-read — GET /users/me", status === 200 ? "PASS" : "FAIL", `HTTP ${status}${status === 200 ? `, status=${body?.status ?? "unknown"}` : ""}`);
    } catch (error) {
      record("Authenticated self-read — GET /users/me", "FAIL", error.message);
    }

    // Deliberately invalid order (bad marketId) — must 400, never 2xx.
    try {
      const { status } = await request(apiBase, "/trading/orders", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ marketId: "not-a-uuid", outcomeId: "not-a-uuid", side: "BUY", type: "LIMIT", quantity: "1" }),
      });
      record("Authenticated order validation — POST /trading/orders (malformed)", status === 400 ? "PASS" : "FAIL", `HTTP ${status} (expected 400)`);
      if (status >= 200 && status < 300) record("SAFETY ALERT", "FAIL", "A malformed order was ACCEPTED with a valid session — investigate immediately, do not ignore.");
    } catch (error) {
      record("Authenticated order validation — POST /trading/orders (malformed)", "FAIL", error.message);
    }

    // Deliberately invalid withdrawal (missing required fields) — must 400.
    try {
      const { status } = await request(apiBase, "/wallet/withdrawals", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ assetSymbol: "", networkCode: "", amount: "not-a-number", destinationAddress: "x" }),
      });
      record("Authenticated withdrawal validation — POST /wallet/withdrawals (malformed)", status === 400 ? "PASS" : "FAIL", `HTTP ${status} (expected 400)`);
      if (status >= 200 && status < 300) record("SAFETY ALERT", "FAIL", "A malformed withdrawal was ACCEPTED with a valid session — investigate immediately, do not ignore.");
    } catch (error) {
      record("Authenticated withdrawal validation — POST /wallet/withdrawals (malformed)", "FAIL", error.message);
    }
  } else {
    record("Authenticated self-read, order validation, withdrawal validation", "SKIPPED", "no test-user session available");
  }

  // ── 9. Admin checks (only if an admin token is supplied) ────────────
  if (adminToken) {
    const adminHeaders = { Authorization: `Bearer ${adminToken}` };

    try {
      const { status, body } = await request(apiBase, "/admin/watchers", { headers: adminHeaders });
      const staleCount = Array.isArray(body) ? body.filter((w) => w.isScanStale || w.isLeaseStale).length : null;
      record("Worker/watcher health — GET /admin/watchers", status === 200 ? "PASS" : "FAIL", status === 200 ? `HTTP 200${staleCount !== null ? `, ${staleCount} stale cursor(s)` : ""}` : `HTTP ${status}`);
    } catch (error) {
      record("Worker/watcher health — GET /admin/watchers", "FAIL", error.message);
    }

    try {
      const { status, body } = await request(apiBase, "/admin/watchers/withdrawals", { headers: adminHeaders });
      record("Withdrawal watcher health — GET /admin/watchers/withdrawals", status === 200 ? "PASS" : "FAIL", `HTTP ${status}`);
    } catch (error) {
      record("Withdrawal watcher health — GET /admin/watchers/withdrawals", "FAIL", error.message);
    }

    try {
      const { status, body } = await request(apiBase, "/admin/reconciliation/discrepancies?status=OPEN", { headers: adminHeaders });
      const openCount = Array.isArray(body) ? body.length : Array.isArray(body?.data) ? body.data.length : null;
      const criticalOpen = Array.isArray(body) ? body.some((d) => d.severity === "CRITICAL") : Array.isArray(body?.data) ? body.data.some((d) => d.severity === "CRITICAL") : false;
      record("Reconciliation status — GET /admin/reconciliation/discrepancies?status=OPEN", status === 200 ? "PASS" : "FAIL", status === 200 ? `HTTP 200, ${openCount ?? "?"} open discrepancy(ies)${criticalOpen ? " — AT LEAST ONE IS CRITICAL, investigate before proceeding" : ""}` : `HTTP ${status}`);
    } catch (error) {
      record("Reconciliation status — GET /admin/reconciliation/discrepancies?status=OPEN", "FAIL", error.message);
    }
  } else {
    record("Worker health, watcher health, reconciliation status (admin)", "SKIPPED", "SMOKE_TEST_ADMIN_TOKEN not set");
  }

  // ── 10. Observability/logging (cannot be checked over HTTP) ─────────
  record("CloudWatch alarms/logs actually receiving data", "UNVERIFIED", "Requires AWS Console/CLI access this script deliberately does not use — check the CloudWatch log groups and the SNS-subscribed alarm state manually.");

  const pass = RESULTS.filter((r) => r.status === "PASS").length;
  const fail = RESULTS.filter((r) => r.status === "FAIL").length;
  const skipped = RESULTS.filter((r) => r.status === "SKIPPED").length;
  const unverified = RESULTS.filter((r) => r.status === "UNVERIFIED").length;

  console.log(`\n=== Summary: ${pass} PASS / ${fail} FAIL / ${skipped} SKIPPED / ${unverified} UNVERIFIED (of ${RESULTS.length}) ===`);
  if (fail > 0) {
    console.log("FAIL — at least one required check failed. Do not declare this deployment healthy.");
    process.exitCode = 1;
    return;
  }
  console.log("PASS — no required check failed. SKIPPED items were not executed because optional credentials were not supplied, not because they passed.");
  process.exitCode = 0;
}

main().catch((error) => {
  console.error("Smoke test crashed:", error.message);
  process.exitCode = 1;
});
