/**
 * Shared auth for scheduled Edge endpoints (cron): `Authorization: Bearer <secret>`.
 *
 * Production: set `INTERNAL_CRON_SECRET` to a dedicated random secret. The bearer must match it.
 * The Supabase service role must **not** be accepted as the cron bearer (same privilege as DB admin).
 *
 * Compares SHA-256(secret) to SHA-256(token) with a constant-time byte comparison so callers cannot
 * incrementally guess the secret via string `===` short-circuit timing.
 */
/** Exported for unit tests and reuse; compares fixed-length digests or any equal-length secrets. */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function sha256Utf8(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

type DenoEnv = { env: { get: (key: string) => string | undefined } };

function cronAuthSecretFromEnv(): string {
  const deno = (globalThis as unknown as { Deno?: DenoEnv }).Deno;
  const env = deno?.env;
  if (!env) return "";

  const internalRaw = env.get("INTERNAL_CRON_SECRET");
  const internal = (internalRaw === undefined ? "" : internalRaw).trim();
  return internal;
}

export async function assertCronAuth(req: Request): Promise<boolean> {
  const secret = cronAuthSecretFromEnv();
  if (!secret) return false;

  const raw = req.headers.get("authorization");
  if (raw == null || raw === "") return false;

  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (token === "") return false;

  const [digestAuth, digestSecret] = await Promise.all([sha256Utf8(token), sha256Utf8(secret)]);
  return timingSafeEqualBytes(digestAuth, digestSecret);
}
