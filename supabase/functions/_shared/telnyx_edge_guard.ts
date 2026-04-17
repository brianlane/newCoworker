/**
 * §7 Edge webhook hardening: client IP extraction + rate-check RPC wrapper.
 */

/** Edge: `readTelnyxWebhookRateLimits((k) => Deno.env.get(k))`. Tests: pass a stub map. */
export function readTelnyxWebhookRateLimits(
  envGet: (key: string) => string | undefined
): { maxPerWindow: number; windowSeconds: number; failOpen: boolean } {
  const max = Number(envGet("TELNYX_WEBHOOK_RATE_MAX_PER_MINUTE") ?? "240");
  const windowSec = Number(envGet("TELNYX_WEBHOOK_RATE_WINDOW_SEC") ?? "60");
  // Default fail-CLOSED: a DB outage must not silently disable rate limiting, since that
  // opens a spoof+flood window where anyone who can forge a Telnyx signature (or replay
  // a recent real one within clock skew) can hammer the edge function. Operators can
  // explicitly opt into fail-open with TELNYX_WEBHOOK_RATE_FAIL_OPEN=true during incidents.
  const failOpenEnv = (envGet("TELNYX_WEBHOOK_RATE_FAIL_OPEN") ?? "false").trim().toLowerCase();
  const failOpen = failOpenEnv === "true" || failOpenEnv === "1" || failOpenEnv === "yes";
  return {
    maxPerWindow: Number.isFinite(max) && max > 0 ? max : 240,
    windowSeconds: Number.isFinite(windowSec) && windowSec > 0 ? windowSec : 60,
    failOpen
  };
}

export function telnyxWebhookClientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();
  return "unknown";
}

type RpcSupabase = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export async function telnyxWebhookRateAllow(
  supabase: RpcSupabase,
  ip: string,
  route: string,
  limits: { maxPerWindow: number; windowSeconds: number; failOpen?: boolean }
): Promise<{ ok: boolean; raw: unknown; failClosed?: boolean }> {
  const { data, error } = await supabase.rpc("telnyx_webhook_rate_check", {
    p_ip: ip,
    p_route: route,
    p_max_per_window: limits.maxPerWindow,
    p_window_seconds: limits.windowSeconds
  });
  if (error) {
    console.error("telnyx_webhook_rate_check", error);
    // Fail CLOSED by default: reject with ok=false so the caller returns 429/503.
    // Operators can flip to legacy fail-open behavior via TELNYX_WEBHOOK_RATE_FAIL_OPEN=true.
    if (limits.failOpen) {
      return { ok: true, raw: { rate_check_error: error.message, fail_open: true }, failClosed: false };
    }
    return { ok: false, raw: { rate_check_error: error.message, fail_closed: true }, failClosed: true };
  }
  const j = data as { ok?: boolean } | null;
  return { ok: j?.ok !== false, raw: data };
}
