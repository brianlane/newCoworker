/**
 * Per-tenant messaging channel resolution (Edge runtime).
 *
 * RCS is an Enterprise perk: sends go RCS-first (Telnyx
 * `POST /v2/messages/rcs`, verified-brand sender) with automatic SMS fallback
 * from the tenant's existing number. This helper decides — per business —
 * whether outbound customer messages may use the RCS channel.
 *
 * The gate is deliberately three-way AND:
 *   tier allows (enterprise)  ∧  rcs_enabled  ∧  rcs_agent_id set
 * so a tier downgrade, an operator kill switch, or a not-yet-approved agent
 * each independently demote traffic to plain SMS. Any lookup error also
 * resolves to null (fail-safe: SMS always works).
 *
 * Mirrors the Next.js-side resolution in src/lib/telnyx/messaging.ts
 * (getTelnyxMessagingForBusiness) — keep the two in sync.
 */

// Minimal structural type so this module works with the esm.sh supabase-js
// the Edge functions use without importing it here.
type ChannelSupabase = {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};

/**
 * Tiers entitled to the RCS channel.
 *
 * Enterprise-only (decided Jul 18 2026): an RCS inbound identifies only the
 * agent — no recipient DID — so a shared agent cannot route replies for more
 * than one tenant, and the agent's verified brand replaces the tenant's own
 * identity on the handset. Tenant RCS requires a dedicated per-tenant agent
 * (own Google verification, own Telnyx carrier fees) — an Enterprise line
 * item. Mirror of src/lib/telnyx/messaging.ts.
 */
export function rcsTierAllowed(tier: string | null | undefined): boolean {
  return tier === "enterprise";
}

/**
 * Resolve the tenant's RCS agent id, or null when the tenant must use plain
 * SMS. Pass `tier` when the caller already fetched it (most do); otherwise
 * it is looked up from `businesses`.
 */
export async function resolveRcsAgentId(
  supabase: ChannelSupabase,
  businessId: string,
  tier?: string | null
): Promise<string | null> {
  let effectiveTier = tier;
  if (effectiveTier === undefined) {
    const { data, error } = await supabase
      .from("businesses")
      .select("tier")
      .eq("id", businessId)
      .maybeSingle();
    if (error) return null;
    effectiveTier = (data as { tier?: string | null } | null)?.tier ?? null;
  }
  if (!rcsTierAllowed(effectiveTier)) return null;

  const { data, error } = await supabase
    .from("business_channel_settings")
    .select("rcs_agent_id, rcs_enabled")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) return null;
  const row = data as { rcs_agent_id?: string | null; rcs_enabled?: boolean } | null;
  if (!row?.rcs_enabled) return null;
  const agentId = (row.rcs_agent_id ?? "").trim();
  return agentId.length > 0 ? agentId : null;
}
