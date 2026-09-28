/**
 * Phase 37 — client-IP resolution behind a reverse proxy.
 *
 * Every @Throttle limit (login/register/refresh 10/min, withdrawals
 * 10/min, trading 120/min, the 100/min global default) is keyed by
 * `req.ip`. Express derives `req.ip` from the TCP peer unless
 * `trust proxy` is set — and in the designed deployment every request
 * reaches the API through the ALB (infra/terraform/modules/alb), so the
 * peer is always one of the ALB's own addresses. Without this setting
 * every client on the platform shares ONE throttle bucket: a single
 * client (or ordinary load) exhausts login for everyone, and no limit is
 * actually per-client.
 *
 * The value is a HOP COUNT, never `true`: Express then takes the address
 * that many hops from the right of X-Forwarded-For — the one the trusted
 * proxy itself appended — so a client-supplied X-Forwarded-For prefix
 * can't spoof its way into another bucket. Default 0 (trust nothing)
 * preserves direct-exposure behavior; set TRUST_PROXY_HOPS=1 behind
 * exactly one ALB. Setting it higher than the real number of proxies
 * WOULD let clients choose their own IP — it must match the topology.
 */
export function configureTrustProxy(app: { set(setting: string, value: unknown): unknown }, hops: number): void {
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUST_PROXY_HOPS must be a non-negative integer (got ${hops}).`);
  }
  if (hops > 0) {
    app.set("trust proxy", hops);
  }
}
