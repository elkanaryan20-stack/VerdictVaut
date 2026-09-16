/**
 * Phase 29 — a safe, read-only DEPLOYMENT/INFRASTRUCTURE preflight,
 * distinct from (and complementary to) the two existing readiness
 * tools:
 *
 *   - `production-readiness-check.js` asks "does the APPLICATION's own
 *     configuration/code allow production financial activity" (JWT
 *     secrets, custody/compliance provider integration, CORS, email).
 *   - `staging-preflight-check.js` asks "is a SANDBOX smoke test ready
 *     to attempt right now" (DB-driven provider-config checks).
 *   - THIS script asks "is the surrounding AWS/Terraform/CI/CD
 *     DEPLOYMENT infrastructure structurally ready" — it deliberately
 *     never duplicates the application-level checks above; where a
 *     category overlaps, it cross-references the other script instead
 *     of re-implementing the same check twice.
 *
 * This script NEVER:
 *   - prints a secret/credential VALUE (only variable/file NAMES and
 *     boolean presence);
 *   - calls a mutating/destructive AWS API (only an optional,
 *     best-effort, strictly READ-ONLY `aws sts get-caller-identity`
 *     if the `aws` CLI happens to be installed and credentials happen
 *     to be configured — never required, never assumed);
 *   - requires live AWS access to produce a meaningful report — every
 *     category that genuinely cannot be checked without AWS/GitHub API
 *     access is reported as UNVERIFIED, with an explicit note on how a
 *     human verifies it, never silently reported as PASS.
 *
 * Usage: `node scripts/production-preflight.js`
 * Exit code: 1 if any locally-verifiable prerequisite is confirmed
 * BLOCKED (a real, checkable negative fact — e.g. the Terraform backend
 * still points at the placeholder bucket); 0 otherwise, including when
 * every remaining item is UNVERIFIED (an unknown is not a failure of
 * this tool, and this script must never claim "all clear" about
 * something it cannot actually see).
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const RESULTS = [];

function check(category, label, status, detail) {
  RESULTS.push({ category, label, status, detail });
}

function fileContains(relativePath, needle) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8").includes(needle);
  } catch {
    return null; // file missing/unreadable — distinct from "found" / "not found"
  }
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(REPO_ROOT, relativePath));
}

// ── 1. AWS account/credentials ──────────────────────────────────────
function checkAwsAccount() {
  const CATEGORY = "AWS account/configuration";
  let awsCliAvailable = false;
  try {
    execFileSync("aws", ["--version"], { stdio: "pipe" });
    awsCliAvailable = true;
  } catch {
    awsCliAvailable = false;
  }

  if (!awsCliAvailable) {
    check(CATEGORY, "AWS CLI available in this shell", "UNVERIFIED", "`aws` not found in PATH — this is expected/normal in a dev shell and is NOT itself a blocker; a human deploying for real should confirm AWS account access via their own authenticated shell/CI role, not this script.");
    check(CATEGORY, "AWS account is reachable with valid credentials", "UNVERIFIED", "Cannot check without the AWS CLI — see previous line.");
    return;
  }

  check(CATEGORY, "AWS CLI available in this shell", "PASS", "found in PATH");

  try {
    // Read-only, identity-only call — never a mutating API, never prints
    // the caller's own account ID/ARN (those aren't secrets, but this
    // script's own discipline is "presence/success only," consistently
    // applied even where the value itself would be technically safe).
    execFileSync("aws", ["sts", "get-caller-identity"], { stdio: "pipe", timeout: 10000 });
    check(CATEGORY, "AWS account is reachable with valid credentials", "PASS", "`aws sts get-caller-identity` succeeded (read-only identity check only — no resource was inspected or modified)");
  } catch (error) {
    check(CATEGORY, "AWS account is reachable with valid credentials", "UNVERIFIED", `\`aws sts get-caller-identity\` failed or timed out — expected if no AWS account/credentials exist yet (this repository's own standing state as of Phase 28). Detail: ${(error.message || String(error)).split("\n")[0]}`);
  }
}

// ── 2. Terraform remote state backend ───────────────────────────────
function checkTerraformBackend() {
  const CATEGORY = "Terraform remote state backend";
  for (const env of ["staging", "production", "shared"]) {
    const relPath = `infra/terraform/environments/${env}/backend.tf`;
    const content = fileContains(relPath, "EXAMPLE ONLY");
    if (content === null) {
      check(CATEGORY, `${env}/backend.tf exists`, "FAIL", "file missing — this should never happen on an unmodified checkout");
    } else if (content === true) {
      check(CATEGORY, `${env} state backend configured with a real bucket/table`, "BLOCKED", "backend.tf still references the placeholder \"EXAMPLE ONLY\" bucket/table — see infra/terraform/README.md's \"State storage and locking design\" and docs/aws-production-change-control.md §4 step 3 for how to provision the real S3 bucket + DynamoDB table (a one-time, human, out-of-band action)");
    } else {
      check(CATEGORY, `${env} state backend configured with a real bucket/table`, "PASS", "backend.tf no longer contains the EXAMPLE ONLY placeholder — verify manually that the referenced bucket/table actually exist and are correctly configured (versioned, encrypted, public access blocked); this script only checks that the placeholder was replaced, not that the real values are correct");
    }
  }
}

// ── 3. Terraform variables supplied per environment ─────────────────
function checkTerraformVars() {
  const CATEGORY = "Terraform variables";
  for (const env of ["staging", "production", "shared"]) {
    const realTfvars = `infra/terraform/environments/${env}/terraform.tfvars`;
    const exampleTfvars = `infra/terraform/environments/${env}/terraform.tfvars.example`;
    if (!fileExists(exampleTfvars)) {
      check(CATEGORY, `${env}/terraform.tfvars.example exists`, "FAIL", "missing — should never happen on an unmodified checkout");
      continue;
    }
    if (fileExists(realTfvars)) {
      check(CATEGORY, `${env} has a real terraform.tfvars (presence only — contents not read)`, "PASS", "present — this script does not validate its contents; run a real `terraform plan` for that");
    } else {
      check(CATEGORY, `${env} has a real terraform.tfvars`, "BLOCKED", `not present — copy ${exampleTfvars} to terraform.tfvars and fill in real, non-placeholder values before a real \`terraform plan\` can succeed for ${env}`);
    }
  }
}

// ── 4. Production AWS IAM/OIDC configuration ────────────────────────
function checkIamOidc() {
  const CATEGORY = "Production AWS IAM/OIDC configuration";
  const moduleExists = fileExists("infra/terraform/modules/ci-deploy-role/main.tf");
  check(CATEGORY, "CI deploy role + GitHub OIDC provider defined in Terraform", moduleExists ? "PASS" : "FAIL", moduleExists ? "infra/terraform/modules/ci-deploy-role (Phase 28) — DESIGNED, still NOT PROVISIONED" : "modules/ci-deploy-role is missing");

  const secretNames = ["AWS_TERRAFORM_ROLE_ARN", "AWS_CI_DEPLOY_ROLE_ARN"];
  for (const name of secretNames) {
    const setLocally = Boolean(process.env[name]);
    check(
      CATEGORY,
      `${name} GitHub Actions secret is configured`,
      "UNVERIFIED",
      setLocally
        ? `set in THIS local shell's environment (informational only — this does NOT mean the real GitHub Actions secret is set; GitHub secrets cannot be read or verified by any script, only by a repository admin in Settings > Secrets and variables > Actions)`
        : `not set in this local shell (expected — GitHub secrets are never available to a local/CI checkout of this script). A human with repository admin access must confirm this secret exists in Settings > Secrets and variables > Actions — this script cannot check that for you.`,
    );
  }

  check(CATEGORY, "GitHub Environment protection rules (required reviewers) configured", "UNVERIFIED", "Cannot be checked by any script — requires a repository admin to inspect Settings > Environments for `staging-infra-apply`/`staging-deploy`/`production-infra-apply`/`production-deploy` and confirm required reviewers are set on at least the production pair. See docs/aws-production-change-control.md §1.");
}

// ── 5. DNS/ACM configuration ─────────────────────────────────────────
function checkDnsAcm() {
  const CATEGORY = "DNS/ACM configuration";
  for (const env of ["staging", "production"]) {
    const realTfvars = `infra/terraform/environments/${env}/terraform.tfvars`;
    if (!fileExists(realTfvars)) {
      check(CATEGORY, `${env}: domain/certificate configuration`, "BLOCKED", `no real terraform.tfvars exists — certificate_arn/domain has never been set (see Terraform variables section above). See docs/aws-region-selection.md and docs/aws-production-architecture.md §10 for the underlying REQUIRES HUMAN APPROVAL decision this depends on.`);
      continue;
    }
    const hasCertArn = fileContains(realTfvars, "certificate_arn") && !fileContains(realTfvars, "# certificate_arn left unset");
    check(CATEGORY, `${env}: certificate_arn appears set in terraform.tfvars (presence only)`, hasCertArn ? "PASS" : "BLOCKED", hasCertArn ? "a certificate_arn assignment was found — this script does not validate the ARN is real/valid" : "no active certificate_arn assignment found — a real, DNS-validated ACM certificate does not exist yet");
  }
}

// ── 6. Cross-references to the other two tools (no duplication) ─────
function crossReferenceOtherTools() {
  check("Production secrets / email / custody / compliance / database", "See production-readiness-check.js", "INFO", "This script deliberately does not re-check DATABASE_URL, JWT secrets, EMAIL_PROVIDER, custody/compliance provider integration, or managed-backup decisions — run `npm run check:production-readiness -w apps/api` for those (the single authoritative application-level gate).");
  check("Sandbox provider configuration", "See staging-preflight-check.js", "INFO", "This script deliberately does not re-check Fireblocks/Elliptic sandbox ProviderConfig rows — run `node scripts/staging-preflight-check.js` (requires a reachable DATABASE_URL) for that.");
}

function main() {
  console.log("=== VerdictVaut production DEPLOYMENT preflight (Phase 29) ===");
  console.log("Checks AWS/Terraform/CI-CD/DNS structural readiness only — read-only, never destructive, never requires live AWS access to run.\n");

  checkAwsAccount();
  checkTerraformBackend();
  checkTerraformVars();
  checkIamOidc();
  checkDnsAcm();
  crossReferenceOtherTools();

  let lastCategory = null;
  for (const r of RESULTS) {
    if (r.category !== lastCategory) {
      console.log(`\n-- ${r.category} --`);
      lastCategory = r.category;
    }
    console.log(`  [${r.status}] ${r.label}${r.detail ? " — " + r.detail : ""}`);
  }

  const pass = RESULTS.filter((r) => r.status === "PASS").length;
  const blocked = RESULTS.filter((r) => r.status === "BLOCKED").length;
  const unverified = RESULTS.filter((r) => r.status === "UNVERIFIED").length;
  const fail = RESULTS.filter((r) => r.status === "FAIL").length;
  const info = RESULTS.filter((r) => r.status === "INFO").length;

  console.log(`\n=== Summary: ${pass} PASS / ${blocked} BLOCKED / ${unverified} UNVERIFIED / ${fail} FAIL / ${info} INFO (of ${RESULTS.length}) ===`);

  if (fail > 0) {
    console.log("\nFAIL — a locally-verifiable file/structure problem was found (not an external-dependency gap). Fix these first.");
    process.exitCode = 1;
    return;
  }
  if (blocked > 0) {
    console.log("\nBLOCKED on real, locally-confirmed prerequisites (e.g. Terraform state backend not yet provisioned). This is the expected, honest state before an AWS account/deployment target is authorized — not a bug in this script.");
    process.exitCode = 1;
    return;
  }
  console.log("\nNo locally-verifiable blocker found. This does NOT mean production is ready — most real prerequisites (AWS account, GitHub secrets/Environments, real Terraform values) are UNVERIFIED above and can only be confirmed by a human with the relevant access. See docs/production-readiness-checklist.md for the full external-prerequisite table.");
  process.exitCode = 0;
}

main();
