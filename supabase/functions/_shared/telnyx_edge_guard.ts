/**
 * §7 Edge webhook hardening: client IP extraction + rate-check RPC wrapper.
 */

/** Edge: `readTelnyxWebhookRateLimits((k) => Deno.env.get(k))`. Tests: pass a stub map. */
export function readTelnyxWebhookRateLimits(
  envGet: (key: string) => string | undefined
): { maxPerWindow: number; windowSeconds: number } {
  const max = Number(envGet("TELNYX_WEBHOOK_RATE_MAX_PER_MINUTE") ?? "240");
  const windowSec = Number(envGet("TELNYX_WEBHOOK_RATE_WINDOW_SEC") ?? "60");
  return {
    maxPerWindow: Number.isFinite(max) && max > 0 ? max : 240,
    windowSeconds: Number.isFinite(windowSec) && windowSec > 0 ? windowSec : 60
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
  limits: { maxPerWindow: number; windowSeconds: number }
): Promise<{ ok: boolean; raw: unknown }> {
  const { data, error } = await supabase.rpc("telnyx_webhook_rate_check", {
    p_ip: ip,
    p_route: route,
    p_max_per_window: limits.maxPerWindow,
    p_window_seconds: limits.windowSeconds
  });
  if (error) {
    console.error("telnyx_webhook_rate_check", error);
    return { ok: true, raw: null };
  }
  const j = data as { ok?: boolean } | null;
  return { ok: j?.ok !== false, raw: data };
}
