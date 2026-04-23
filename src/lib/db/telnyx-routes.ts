/**
 * Persistence for the per-DID → business routing tables.
 *
 *   - `telnyx_voice_routes`       : to_e164 PK → business_id (routes inbound voice + SMS)
 *   - `business_telnyx_settings`  : business_id PK → per-tenant messaging profile,
 *                                   SMS from-number, Call Control connection, bridge origin.
 *
 * The voice-inbound Edge function and the SMS worker both read from
 * `telnyx_voice_routes` by `to_e164`, so renaming this table is a cross-
 * function change — see the migration's comment header for details.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type TelnyxVoiceRouteRow = {
  to_e164: string;
  business_id: string;
  media_wss_origin: string | null;
  media_path: string;
  created_at: string;
};

export type BusinessTelnyxSettingsRow = {
  business_id: string;
  telnyx_messaging_profile_id: string | null;
  telnyx_sms_from_e164: string | null;
  telnyx_connection_id: string | null;
  bridge_media_wss_origin: string | null;
  bridge_media_path: string;
  bridge_last_heartbeat_at: string | null;
  bridge_last_error_at: string | null;
  bridge_error_message: string | null;
  telnyx_tcr_brand_id: string | null;
  telnyx_tcr_campaign_id: string | null;
  forward_to_e164: string | null;
  transfer_enabled: boolean;
  sms_fallback_enabled: boolean;
  updated_at: string;
};

export async function getTelnyxVoiceRouteForBusiness(
  businessId: string,
  client?: SupabaseClient
): Promise<TelnyxVoiceRouteRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("telnyx_voice_routes")
    .select("*")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getTelnyxVoiceRouteForBusiness: ${error.message}`);
  return (data as TelnyxVoiceRouteRow | null) ?? null;
}

export type UpsertTelnyxVoiceRouteInput = {
  toE164: string;
  businessId: string;
  mediaWssOrigin?: string | null;
  mediaPath?: string;
};

export async function upsertTelnyxVoiceRoute(
  input: UpsertTelnyxVoiceRouteInput,
  client?: SupabaseClient
): Promise<TelnyxVoiceRouteRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("telnyx_voice_routes")
    .upsert(
      {
        to_e164: input.toE164,
        business_id: input.businessId,
        media_wss_origin: input.mediaWssOrigin ?? null,
        media_path: input.mediaPath ?? "/voice/stream"
      },
      { onConflict: "to_e164" }
    )
    .select()
    .single();
  if (error) throw new Error(`upsertTelnyxVoiceRoute: ${error.message}`);
  return data as TelnyxVoiceRouteRow;
}

export async function getBusinessTelnyxSettings(
  businessId: string,
  client?: SupabaseClient
): Promise<BusinessTelnyxSettingsRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("business_telnyx_settings")
    .select("*")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getBusinessTelnyxSettings: ${error.message}`);
  return (data as BusinessTelnyxSettingsRow | null) ?? null;
}

export type UpsertBusinessTelnyxSettingsInput = {
  businessId: string;
  telnyxMessagingProfileId?: string | null;
  telnyxSmsFromE164?: string | null;
  telnyxConnectionId?: string | null;
  bridgeMediaWssOrigin?: string | null;
  bridgeMediaPath?: string;
  forwardToE164?: string | null;
  transferEnabled?: boolean;
  smsFallbackEnabled?: boolean;
};

export async function upsertBusinessTelnyxSettings(
  input: UpsertBusinessTelnyxSettingsInput,
  client?: SupabaseClient
): Promise<BusinessTelnyxSettingsRow> {
  const db = client ?? (await createSupabaseServiceClient());
  // Build the row from a declarative column map so each optional field is
  // handled uniformly — no per-field if/else branches, which keeps branch
  // coverage deterministic regardless of which subset of fields the caller
  // supplies.
  const columnMap: Array<[keyof UpsertBusinessTelnyxSettingsInput, string]> = [
    ["telnyxMessagingProfileId", "telnyx_messaging_profile_id"],
    ["telnyxSmsFromE164", "telnyx_sms_from_e164"],
    ["telnyxConnectionId", "telnyx_connection_id"],
    ["bridgeMediaWssOrigin", "bridge_media_wss_origin"],
    ["bridgeMediaPath", "bridge_media_path"],
    ["forwardToE164", "forward_to_e164"],
    ["transferEnabled", "transfer_enabled"],
    ["smsFallbackEnabled", "sms_fallback_enabled"]
  ];
  const row: Record<string, unknown> = {
    business_id: input.businessId,
    updated_at: new Date().toISOString()
  };
  for (const [inputKey, column] of columnMap) {
    const value = input[inputKey];
    if (value !== undefined) row[column] = value;
  }

  const { data, error } = await db
    .from("business_telnyx_settings")
    .upsert(row, { onConflict: "business_id" })
    .select()
    .single();
  if (error) throw new Error(`upsertBusinessTelnyxSettings: ${error.message}`);
  return data as BusinessTelnyxSettingsRow;
}

/**
 * E.164 format: `+` then 8–15 digits, first digit 1–9. Matches the CHECK
 * constraint in 20260425000000_telnyx_transfer_forwarding.sql so we reject
 * at the API layer with a friendly message instead of letting Postgres
 * throw a raw constraint violation.
 */
export const E164_REGEX = /^\+[1-9][0-9]{7,14}$/;

/**
 * Upsert (or clear) the owner/staff forwarding cell. Passing null/empty
 * clears the column. Safe Mode depends on this being set.
 */
export async function setForwardToE164(
  businessId: string,
  phone: string | null,
  client?: SupabaseClient
): Promise<BusinessTelnyxSettingsRow> {
  const normalized = phone && phone.trim() ? phone.trim() : null;
  if (normalized !== null && !E164_REGEX.test(normalized)) {
    throw new Error("setForwardToE164: invalid E.164 phone number");
  }
  return upsertBusinessTelnyxSettings(
    { businessId, forwardToE164: normalized },
    client
  );
}
