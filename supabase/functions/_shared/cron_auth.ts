/**
 * Shared auth for scheduled Edge endpoints (cron): `Authorization: Bearer <secret>`.
 * Prefer `INTERNAL_CRON_SECRET`; falls back to `SUPABASE_SERVICE_ROLE_KEY` only when set (dev convenience).
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

export async function assertCronAuth(req: Request): Promise<boolean> {
  const secret =
    Deno.env.get("INTERNAL_CRON_SECRET") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!secret) return false;
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const [digestAuth, digestSecret] = await Promise.all([sha256Utf8(auth), sha256Utf8(secret)]);
  return timingSafeEqualBytes(digestAuth, digestSecret);
}
