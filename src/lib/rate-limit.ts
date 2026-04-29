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
