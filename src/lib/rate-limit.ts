type RateLimitEntry = {
  count: number;
  resetAt: number;
};

const store = new Map<string, RateLimitEntry>();

export type RateLimitConfig = {
  interval: number;
  maxRequests: number;
};

export type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
};

export function rateLimit(
  identifier: string,
  config: RateLimitConfig,
): RateLimitResult {
  const now = Date.now();

  let cleaned = 0;
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key);
      cleaned++;
      if (cleaned >= 10) break;
    }
  }

  const entry = store.get(identifier);

  if (!entry || entry.resetAt < now) {
    store.set(identifier, {
      count: 1,
      resetAt: now + config.interval,
    });

    return {
      success: true,
      limit: config.maxRequests,
      remaining: config.maxRequests - 1,
      reset: now + config.interval,
    };
  }

  entry.count++;

  if (entry.count > config.maxRequests) {
    return {
      success: false,
      limit: config.maxRequests,
      remaining: 0,
      reset: entry.resetAt,
    };
  }

  return {
    success: true,
    limit: config.maxRequests,
    remaining: config.maxRequests - entry.count,
    reset: entry.resetAt,
  };
}

export const RATE_LIMITS = {
  AUTH: { interval: 15 * 60 * 1000, maxRequests: 5 },
  API: { interval: 60 * 1000, maxRequests: 60 },
  WEBHOOK: { interval: 60 * 1000, maxRequests: 100 },
} as const;

/**
 * Durable, cross-instance rate limit backed by Postgres (the
 * `app_rate_limit_hit` SECURITY DEFINER RPC, service_role-only).
 *
 * Why: the in-memory `rateLimit` above uses a per-process `Map`, which on
 * Vercel serverless is per-isolate and ephemeral — it barely binds across
 * the fleet. This variant records the hit in a shared table so the window
 * is enforced globally, which matters most for UNAUTHENTICATED,
 * cost-amplifying endpoints (LLM-backed onboarding chat / website preview)
 * where a single IP fanned across isolates could otherwise run up spend.
 *
 * Fail-open: if the DB call errors (transient outage, RPC missing on an
 * un-migrated env), we fall back to the in-memory limiter rather than
 * hard-failing the request. A rate limiter must never take down the very
 * endpoint it protects on its own infrastructure blip.
 *
 * Only call from Node runtime route handlers (it imports the service
 * client); never from edge middleware.
 */
const RATE_LIMIT_RPC_TIMEOUT_MS = 1500;

export async function rateLimitDurable(
  identifier: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const windowSeconds = Math.max(1, Math.round(config.interval / 1000));
  try {
    const { createSupabaseServiceClient } = await import("@/lib/supabase/server");
    const db = await createSupabaseServiceClient();
    // Bound the RPC: if PostgREST stalls (vs. erroring), we must still reach
    // the in-memory fallback well within the route budget rather than block.
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("rate_limit_rpc_timeout")), RATE_LIMIT_RPC_TIMEOUT_MS).unref?.();
    });
    const { data, error } = await Promise.race([
      db.rpc("app_rate_limit_hit", {
        p_key: identifier,
        p_max: config.maxRequests,
        p_window_seconds: windowSeconds,
      }),
      timeout,
    ]);
    if (error || !data || typeof data !== "object") {
      return rateLimit(identifier, config);
    }
    const payload = data as { ok?: boolean; hits?: number; reset?: number };
    const hits = typeof payload.hits === "number" ? payload.hits : 0;
    return {
      success: payload.ok !== false,
      limit: config.maxRequests,
      remaining: Math.max(0, config.maxRequests - hits),
      reset: typeof payload.reset === "number" ? payload.reset : Date.now() + config.interval,
    };
  } catch {
    return rateLimit(identifier, config);
  }
}

/**
 * Build a rate-limit identifier from a Web `Request`. Walks the
 * standard proxy-IP header chain (`x-forwarded-for` first, then
 * `x-real-ip`, then `cf-connecting-ip`) and falls back to
 * `"unknown"` so all header-less requests share a single bucket
 * (otherwise an attacker who strips headers would get an unbounded
 * quota).
 *
 * Intentionally distinct from `proxy.ts`'s `getIdentifier` (which
 * prioritizes `x-real-ip` over `x-forwarded-for`) and
 * `checkout/route.ts`'s `readClientIpFromHeaders` (which returns
 * `string | null` for IP-storage rather than `"unknown"` for
 * rate-limit keys). Those two have different fallback semantics on
 * purpose; this helper is for rate-limit-key construction in route
 * handlers and replaces what was previously copy-pasted between
 * `/api/onboard/chat` and `/api/onboard/website-preview`.
 */
export function rateLimitIdentifierFromRequest(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  return "unknown";
}
