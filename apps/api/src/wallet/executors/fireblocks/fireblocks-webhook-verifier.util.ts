import * as crypto from "crypto";

/**
 * Fireblocks' "legacy" webhook signature scheme — VERIFIED against
 * https://developers.fireblocks.com/reference/validating-webhooks
 * (Phase 14B research pass): header `Fireblocks-Signature` =
 * Base64(RSA512(Fireblocks' webhook PRIVATE key, SHA512(raw event
 * body))), verified against a Fireblocks-PUBLISHED public key.
 *
 * A newer JWKS-based scheme (header `Fireblocks-Webhook-Signature`,
 * detached JWS, RS512, key looked up from a published JWKS endpoint by
 * `kid`) also exists per the same research pass but is NOT implemented
 * here — it requires fetching/caching a JWKS document, materially more
 * moving parts than this phase's scope covers. Only the legacy header
 * is checked; see fireblocks-webhook.controller.ts for how an absent
 * legacy header is handled (rejected, never silently accepted).
 *
 * The verification PUBLIC key itself is NOT hardcoded — Fireblocks
 * publishes it, but this research pass did not fetch its actual PEM
 * content from a primary source, so fabricating one here would be
 * worse than not verifying at all (a wrong hardcoded key either always
 * fails, masking the real problem, or — if wrong in a way that happens
 * to validate — would be a real security hole). It is admin-configured
 * via CustodyProviderConfig.webhookSecretRef, resolved the same way any
 * other provider-config reference is (see SecretResolverService).
 */
export function verifyFireblocksWebhookSignature(rawBody: string, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    return crypto.verify("RSA-SHA512", Buffer.from(rawBody, "utf8"), publicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    // A malformed signature/key is a verification FAILURE, never a crash.
    return false;
  }
}
