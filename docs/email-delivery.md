# Account Verification Email — Phase 20

Real Postmark integration for exactly one email: the account
verification email issued by `AuthService.register()` and reissued by
`AuthService.resendVerificationEmail()`. This is **not** a general
notification/messaging framework — see `src/email/email-provider.interface.ts`'s
own docblock for why the interface is deliberately narrow, and
`docs/provider-integration.md` for the unrelated Fireblocks/Elliptic
custody/compliance integrations (a different phase, a different concern).

## 1. Provider decision

Postmark, decided in a prior read-only provider-decision pass (see that
session's own comparison of SES/Postmark/SendGrid). Reasons, briefly:
purpose-built for transactional (not marketing) email, a genuine
self-serve test-token sandbox mode with no approval wait, native
environment separation, and the lowest operational complexity of the
three for this narrow use case.

## 2. Architecture

- `EmailProvider` (`src/email/email-provider.interface.ts`) — the only
  interface `AuthService` depends on. `sendVerificationEmail({ to,
  verificationUrl }): Promise<{ providerMessageId }>`.
- `PostmarkEmailProvider` — real Postmark integration
  (`src/email/postmark-email.provider.ts` + `postmark-http.util.ts`).
  Request/response field names are VERIFIED against Postmark's own
  published API reference (https://postmarkapp.com/developer/api/email-api,
  fetched during this phase) — see `postmark-http.util.ts`'s own
  docblock for the exact verified shape.
- `NoopEmailProvider` — makes no network call of any kind. Selected
  whenever `EMAIL_PROVIDER` is not `postmark`, including every
  automated test run.
- `email-provider.factory.ts` selects between the two, once, at
  application bootstrap, purely from `EMAIL_PROVIDER` — **no
  database-driven provider-configuration system was added** (unlike
  `CustodyProviderConfig`/`ComplianceProviderConfig`); email has none of
  those two's reasons for needing a runtime-toggleable, per-environment
  DB row (see that file's own docblock).
- `verification-email.template.ts` renders the actual subject/HTML/text
  — VerdictVaut branding, no financial/transaction language, the only
  interpolated value is the verification URL itself.

## 3. Required environment configuration

| Variable | Required when | Purpose |
|---|---|---|
| `EMAIL_PROVIDER` | always (defaults to `none`) | `none` = NoopEmailProvider (no real send); `postmark` = real Postmark send |
| `POSTMARK_SERVER_TOKEN` | `EMAIL_PROVIDER=postmark` | The Server API Token from Postmark's dashboard (Servers → your server → API Tokens). Never committed — see `apps/api/.env.example`'s own placeholder. |
| `EMAIL_FROM_ADDRESS` | `EMAIL_PROVIDER=postmark` | Must be on a domain with a verified Sender Signature/DKIM in Postmark. An unverified sender fails closed (Postmark rejects the send; VerdictVaut never silently swallows this — see §6). |
| `EMAIL_BASE_URL` | `EMAIL_PROVIDER=postmark` | Public base URL of the web app, used only to construct the verification link (`{EMAIL_BASE_URL}/verify-email?token=...`). Never fetched by the server itself — see §7's SSRF note. |

## 4. Sender/domain verification (Postmark side, not code)

Before any real send will succeed:

1. Add and verify the sending domain in Postmark (SPF + DKIM DNS
   records).
2. Verify (or use an already-verified) Sender Signature for
   `EMAIL_FROM_ADDRESS`.
3. Generate a Server API Token for the specific Postmark Server you
   intend to use for this environment, and set it as
   `POSTMARK_SERVER_TOKEN`.

None of this is automatable from application code — it is a one-time
account-side setup step.

## 5. Sandbox/staging strategy

- **Local dev / CI / every automated test**: leave `EMAIL_PROVIDER`
  unset (or `none`). `NoopEmailProvider` runs, makes no network call,
  and logs a `verification_email.noop_skipped` line. The pre-existing
  `devVerificationToken` field (still returned outside production —
  see §6) remains the practical way to obtain a raw token for local
  testing without a real inbox.
- **A genuine staging/sandbox smoke test**: set `EMAIL_PROVIDER=postmark`
  with Postmark's own dedicated **test token** (a real API call is
  made, matching the documented request/response contract, but nothing
  is actually delivered) — this is the equivalent, for email, of the
  Fireblocks/Elliptic sandbox smoke test described in
  `docs/fireblocks-sandbox-smoke-test.md`; it has not been executed in
  any session, same as that one.
- **Production**: `EMAIL_PROVIDER=postmark` with a real, live Server
  Token.

## 6. Failure semantics — what happens when email delivery fails

Registration itself is authoritative and is never blocked, delayed, or
rolled back by an email-delivery failure:

- `AuthService.register()` creates the user row and issues real
  access/refresh tokens regardless of whether the verification email
  send succeeds.
- A `PostmarkEmailProvider` failure (timeout, invalid token, unverified
  sender, inactive/bounced recipient, malformed response) is caught
  inside `sendVerificationEmailSafely()`, logged (structured, via the
  existing `JsonLoggerService`) and metriced
  (`auth.verification_email.send_failed`), and never rethrown to the
  HTTP caller.
- The user remains `PENDING_VERIFICATION` either way — a send failure
  does not activate the account, and it does not fabricate a "delivered"
  claim anywhere.
- The SUPER_ADMIN `adminActivate` escape hatch (`POST
  /admin/users/:id/activate`, Phase 18/19) remains available exactly as
  before if delivery never succeeds.
- **`devVerificationToken` was evaluated for removal this phase and
  deliberately kept** — several existing legitimate integration tests
  (`test/integration/user-activation.integration-spec.ts`) have no other
  way to obtain the raw token, since only its SHA-256 hash is ever
  persisted. It remains strictly non-production (`nodeEnv ===
  "production"` excludes it from the response, unchanged since Phase
  19).
- No retry queue was added — a single transactional verification email
  is disproportionate machinery to justify one. A user (or, before
  Phase 20, only an admin) can request a fresh attempt via §7's resend
  endpoint.

## 7. Resend-verification-email endpoint

`POST /auth/resend-verification-email` — **authenticated** (requires a
valid access token, `JwtAuthGuard`, no `@Roles` restriction), takes no
request body, and always returns the same fixed generic response
regardless of what actually happened.

**Why authenticated, not an unauthenticated "resend by email address"
endpoint**: `JwtStrategy` issues a token regardless of account status
(only a `SUSPENDED` account is blocked at `login()` itself — see
`AuthService.login`), and `JwtAuthGuard` alone (no `@Roles`) never
re-checks DB status either (only `RolesGuard` does, for role-gated
routes) — so a `PENDING_VERIFICATION` user can already reach any
`JwtAuthGuard`-only route today, exactly like `logout()`/
`changePassword()`. Requiring authentication means this endpoint can
only ever act on the calling user's own account, which makes
email-enumeration structurally impossible rather than something a
generic response has to paper over.

Behavior:

- Genuinely `PENDING_VERIFICATION`: a fresh, single-use, 24h-expiring
  token is generated and **atomically replaces** the previous one (a
  single `updateMany` scoped by `{id, status: PENDING_VERIFICATION}`,
  the same CAS pattern `verifyEmail()` uses) — the old token stops
  working the instant the new one is stored, never simultaneously
  valid. A new verification email is sent (or safely fails per §6).
- Already `ACTIVE` or `SUSPENDED`: a safe no-op — no token created, no
  email sent, no distinguishable response.
- Rate-limited at the same tier as every other credential-adjacent
  endpoint on `AuthController` (`AUTH_THROTTLE`, 10/60s) — the existing
  `@nestjs/throttler` infrastructure, not a new mechanism.
- Concurrent resend requests for the same account are safe: whichever
  `updateMany` call Postgres's row-level locking serializes last wins;
  the loser's write still succeeds (both requests are legitimate), but
  only the last-written token hash is ever valid going forward.

## 8. Security review summary

(Full reasoning lives in the Phase 20 implementation report; summarized
here for anyone reading only this doc.)

- **Token leakage**: the raw token/verification URL is never logged
  anywhere — not by `PostmarkEmailProvider`, not by `NoopEmailProvider`,
  not by `AuthService`. Only the recipient address and a classified
  outcome are logged.
- **Email enumeration**: structurally impossible for the resend
  endpoint (see §7) — it has no email-address input at all.
- **Resend abuse**: bounded by `AUTH_THROTTLE`; a resend can only ever
  target the caller's own already-registered address, so it cannot
  become a primitive for spamming an arbitrary third party.
- **Provider credential leakage**: `POSTMARK_SERVER_TOKEN` is read only
  from `ConfigService`/env, never logged, never echoed in any response.
- **SSRF via `EMAIL_BASE_URL`**: none — this value is never fetched by
  the server; it only ever appears inside an email body as a link a
  human clicks. It is also always a fixed operator-set env var, never
  derived from request input, so it cannot become an open-redirect/
  phishing vector either.
- **HTML injection in email content**: the only interpolated value in
  the template is the verification URL, which is always
  server-constructed (a fixed base URL + a `[0-9a-f]{64}` hex token —
  no characters that could break out of an HTML attribute); it is still
  passed through an `escapeHtml()` step as defense-in-depth. The
  recipient's raw email address is deliberately never interpolated into
  the HTML body at all.
- **Production fallback**: `env.validation.ts`'s
  `assertProductionEmailConfigured` refuses to let the process boot at
  all in production unless `EMAIL_PROVIDER=postmark` with all three
  values present and `EMAIL_BASE_URL` a syntactically valid URL — the
  no-op provider can never be silently selected in production, by
  construction, not merely by convention.
- **Race conditions in token replacement / concurrent resends**: both
  covered by the CAS `updateMany` pattern above; see
  `test/integration/resend-verification-email.integration-spec.ts` for
  the real-Postgres concurrent-request proof.

## 9. Known limitation — no corresponding frontend page yet

`EMAIL_BASE_URL + "/verify-email?token=..."` assumes a web page at that
route that reads the `token` query parameter and calls `POST
/auth/verify-email`. No such page exists in `apps/web` as of this
phase — building it was out of this (backend-only) phase's scope. This
is not a new gap introduced by Phase 20: the same link shape was already
implied by `devVerificationToken`'s existence since Phase 18/19; Phase
20 only makes it externally visible via a real email a real user could
receive.
