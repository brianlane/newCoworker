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
  if (!token) return false;

  const digestToken = createHash("sha256").update(token, "utf8").digest();
  const digestSecret = createHash("sha256").update(secret, "utf8").digest();
  if (digestToken.length !== digestSecret.length) return false;
  try {
    return timingSafeEqual(digestToken, digestSecret);
  } catch {
    return false;
  }
}
