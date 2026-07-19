/**
 * Per-tenant messaging channel settings (`business_channel_settings`).
 *
 * Holds the RCS wiring: the tenant's Telnyx RCS agent id and the operator
 * kill switch (`rcs_enabled`, default off). The table is service-role-only
 * for writes (RLS); the admin business page's "Messaging channel (RCS)" card
 * is the operator console — see `POST /api/admin/rcs-channel`.
 *
 * These settings are only one leg of the send-time gate: outbound messages
 * additionally require the enterprise tier (`rcsTierAllowed` in
 * src/lib/telnyx/messaging.ts and the Edge mirror), so writing a row for a
 * lower-tier tenant is harmless — sends stay plain SMS.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ChannelSettings = {
  rcsAgentId: string | null;
  rcsEnabled: boolean;
};

/** Read a tenant's channel settings; a missing row is the all-defaults state. */
export async function getChannelSettings(
  businessId: string,
  client?: SupabaseClient
): Promise<ChannelSettings> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_channel_settings")
    .select("rcs_agent_id, rcs_enabled")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { rcs_agent_id?: string | null; rcs_enabled?: boolean } | null;
  return {
    rcsAgentId: row?.rcs_agent_id ?? null,
    rcsEnabled: row?.rcs_enabled ?? false
  };
}

/**
 * Upsert a tenant's RCS wiring. The agent id is trimmed; blank collapses to
 * null (so "clear the field" in the admin card really clears it). Enabling
 * without an agent id is allowed at the DB layer — the send-time gate
 * requires both, so such a row still sends plain SMS.
 */
export async function upsertChannelSettings(
  businessId: string,
  settings: ChannelSettings,
  client?: SupabaseClient
): Promise<ChannelSettings> {
  const db = client ?? (await createSupabaseServiceClient());
  const agentId = (settings.rcsAgentId ?? "").trim() || null;
  const { error } = await db
    .from("business_channel_settings")
    .upsert(
      {
        business_id: businessId,
        rcs_agent_id: agentId,
        rcs_enabled: settings.rcsEnabled,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id" }
    );
  if (error) throw new Error(error.message);
  return { rcsAgentId: agentId, rcsEnabled: settings.rcsEnabled };
}
