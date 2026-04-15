/**
 * Shared auth for scheduled Edge endpoints (cron): `Authorization: Bearer <secret>`.
 * Prefer `INTERNAL_CRON_SECRET`; falls back to `SUPABASE_SERVICE_ROLE_KEY` only when set (dev convenience).
 */
export function assertCronAuth(req: Request): boolean {
  const secret =
    Deno.env.get("INTERNAL_CRON_SECRET") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!secret) return false;
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  return auth.length > 0 && auth === secret;
}
