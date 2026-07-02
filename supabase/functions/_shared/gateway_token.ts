/**
 * Per-tenant Rowboat gateway-token resolution for the Deno edge workers.
 *
 * Mirrors `resolveOutboundRowboatBearer` in src/lib/rowboat/gateway-token.ts
 * (the Next side): prefer the business's CONFIRMED-deployed token from
 * `vps_gateway_tokens` (deployed_at set, not revoked), fall back to the legacy
 * shared `ROWBOAT_VPS_CHAT_BEARER` / `ROWBOAT_GATEWAY_TOKEN` env secret.
 *
 * Why this exists: migration 20260629020000_vps_gateway_tokens.sql moved each
 * tenant's Rowboat onto its OWN api key. Once a box is re-keyed, its Rowboat
 * rejects the shared env token ("Invalid API key" → HTTP 500), so any worker
 * still sending the env bearer dead-letters every job for that tenant — that
 * is exactly how customer SMS silently broke after Amy's June 19 redeploy.
 * (Worker → PLATFORM calls are unaffected: the app accepts the shared token
 * as a fallback. This resolver is for worker → tenant-VPS Rowboat calls.)
 *
 * Only the confirmed-deployed token is used (never a pending one) so the
 * worker can't get ahead of a half-finished deploy — the same "confirmed or
 * env fallback" contract as the Next resolver. Fails over to the env value on
 * any DB error: an outage of the token table must not take down SMS for
 * tenants still on the shared secret.
 */

/** Minimal structural client (same pattern as _shared/telemetry.ts). */
type TokenSupabase = {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        is(
          column: string,
          value: null
        ): {
          not(
            column: string,
            op: string,
            value: null
          ): {
            order(
              column: string,
              opts: { ascending: boolean }
            ): {
              limit(n: number): {
                maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
              };
            };
          };
        };
      };
    };
  };
};

/** The legacy shared platform secret (transition fallback). Runtime-agnostic
 *  (Deno on the edge, Node under Vitest) so the module can be unit-tested —
 *  `Deno` is looked up via globalThis to keep the Node tsc program happy. */
export function sharedEnvRowboatBearer(): string {
  const g = globalThis as {
    Deno?: { env: { get(name: string): string | undefined } };
    process?: { env?: Record<string, string | undefined> };
  };
  const env = (name: string): string | undefined =>
    g.Deno ? g.Deno.env.get(name) : g.process?.env?.[name];
  return env("ROWBOAT_VPS_CHAT_BEARER") ?? env("ROWBOAT_GATEWAY_TOKEN") ?? "";
}

/**
 * Bearer to present to `businessId`'s Rowboat: confirmed per-tenant token,
 * else the shared env fallback (empty string when neither exists).
 */
export async function resolveRowboatBearerForBusiness(
  supabase: TokenSupabase,
  businessId: string
): Promise<string> {
  const envFallback = sharedEnvRowboatBearer();
  try {
    const { data, error } = await supabase
      .from("vps_gateway_tokens")
      .select("token")
      .eq("business_id", businessId)
      .is("revoked_at", null)
      .not("deployed_at", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return envFallback;
    const token = (data as { token?: string } | null)?.token;
    return typeof token === "string" && token.length > 0 ? token : envFallback;
  } catch {
    return envFallback;
  }
}
