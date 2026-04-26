/**
 * Shared Bearer-token auth for internal scheduled endpoints.
 *
 * Mirrors `supabase/functions/_shared/cron_auth.ts` so a pg_cron → Edge-fn
 * → Next.js call chain can use the same `INTERNAL_CRON_SECRET` end-to-end.
 *
 * Production: set `INTERNAL_CRON_SECRET` to a dedicated random secret. The
 * bearer token must match it.
 *
 * Uses SHA-256 + constant-time compare so callers cannot time-leak the
 * secret byte by byte.
 */

import { createHash, timingSafeEqual } from "node:crypto";

function cronSecretFromEnv(): string {
  return (process.env.INTERNAL_CRON_SECRET ?? "").trim();
}

export function assertCronAuth(request: Request): boolean {
  const secret = cronSecretFromEnv();
  if (!secret) return false;

  const raw = request.headers.get("authorization");
  if (!raw) return false;
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  /* v8 ignore next -- Fetch Headers normalize whitespace-only authorization values before this guard. */
  if (!token) return false;

  const digestToken = createHash("sha256").update(token, "utf8").digest();
  const digestSecret = createHash("sha256").update(secret, "utf8").digest();
  /* v8 ignore next -- both values are SHA-256 digests, so their lengths are invariant. */
  if (digestToken.length !== digestSecret.length) return false;
  try {
    return timingSafeEqual(digestToken, digestSecret);
  /* v8 ignore next 3 -- Node can throw for non-Buffer inputs; both digests above are Buffers. */
  /* c8 ignore next 3 -- Node can throw for non-Buffer inputs; both digests above are Buffers. */
  } catch {
    return false;
  }
}
