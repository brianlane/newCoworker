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

export type BusinessTelnyxMessagingCampaignStatus =
  | "pending"
  | "registered"
  | "rejected"
  | "unregistered";

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
  telnyx_messaging_campaign_id: string | null;
  telnyx_messaging_campaign_status: BusinessTelnyxMessagingCampaignStatus;
  telnyx_messaging_campaign_last_error: string | null;
  telnyx_messaging_campaign_attached_at: string | null;
  telnyx_messaging_campaign_last_attempt_at: string | null;
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

export type TendlcRetryCandidate = {
  business_id: string;
  to_e164: string;
  status: BusinessTelnyxMessagingCampaignStatus;
  last_attempt_at: string | null;
};

/**
 * List per-business DIDs that need a 10DLC campaign re-attach. Returns
 * rows whose status is `pending` or `rejected` AND that haven't been
 * retried within `staleAfterSeconds` (default 5 minutes) — bounded by
 * `limit` so a backlog of 1k pending DIDs doesn't burn a full Telnyx
 * budget per cron tick.
 *
 * Joined with `telnyx_voice_routes` because the DID lives there, not on
 * `business_telnyx_settings`. Rows missing a route are filtered out — a
 * business without a DID has nothing to attach.
 */
export async function listBusinessesPendingTendlcAttach(
  options: { staleAfterSeconds?: number; limit?: number } = {},
  client?: SupabaseClient
): Promise<TendlcRetryCandidate[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const stale = Math.max(0, options.staleAfterSeconds ?? 300);
  const limit = Math.min(Math.max(1, options.limit ?? 25), 100);
  const cutoff = new Date(Date.now() - stale * 1000).toISOString();

  // Two-step rather than a Postgres view: keeps the helper testable with
  // the same chain-of-mocks pattern the rest of the codebase uses, and
  // avoids a migration just for one read path. The N+1 is bounded by
  // `limit`; for our scale (≤ 100/tick) this is well under one round-trip.
  const { data: settings, error: sErr } = await db
    .from("business_telnyx_settings")
    .select(
      "business_id, telnyx_messaging_campaign_status, telnyx_messaging_campaign_last_attempt_at"
    )
    .in("telnyx_messaging_campaign_status", ["pending", "rejected"])
    .or(
      `telnyx_messaging_campaign_last_attempt_at.is.null,telnyx_messaging_campaign_last_attempt_at.lt.${cutoff}`
    )
    .order("telnyx_messaging_campaign_last_attempt_at", {
      ascending: true,
      nullsFirst: true
    })
    .limit(limit);
  if (sErr) {
    throw new Error(`listBusinessesPendingTendlcAttach: ${sErr.message}`);
  }
  const rows = (settings as Array<{
    business_id: string;
    telnyx_messaging_campaign_status: BusinessTelnyxMessagingCampaignStatus;
    telnyx_messaging_campaign_last_attempt_at: string | null;
  }> | null) ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.business_id);
  const { data: routes, error: rErr } = await db
    .from("telnyx_voice_routes")
    .select("business_id, to_e164, created_at")
    .in("business_id", ids)
    .order("created_at", { ascending: false });
  if (rErr) {
    throw new Error(`listBusinessesPendingTendlcAttach: ${rErr.message}`);
  }
  // Most-recent route wins (matches `getTelnyxVoiceRouteForBusiness`).
  const routeByBiz = new Map<string, string>();
  for (const route of (routes as Array<{ business_id: string; to_e164: string }> | null) ?? []) {
    if (!routeByBiz.has(route.business_id)) {
      routeByBiz.set(route.business_id, route.to_e164);
    }
  }

  return rows.flatMap((r) => {
    const e164 = routeByBiz.get(r.business_id);
    if (!e164) return [];
    return [
      {
        business_id: r.business_id,
        to_e164: e164,
        status: r.telnyx_messaging_campaign_status,
        last_attempt_at: r.telnyx_messaging_campaign_last_attempt_at
      }
    ];
  });
}

/**
 * Update the per-business 10DLC campaign-attach lifecycle. See migration
 * `20260505210000_business_tendlc_status.sql` for the meaning of each
 * status value. We snapshot:
 *   - `last_attempt_at` on every call (so the cron worker can throttle),
 *   - `attached_at` only when transitioning to `registered`,
 *   - `last_error` only when transitioning to `rejected` (cleared on
 *     `registered` so a successful retry doesn't leave a stale error in the
 *     dashboard banner).
 */
export async function setBusinessMessagingCampaignStatus(
  input: {
    businessId: string;
    status: BusinessTelnyxMessagingCampaignStatus;
    campaignId?: string | null;
    lastError?: string | null;
  },
  client?: SupabaseClient
): Promise<BusinessTelnyxSettingsRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    business_id: input.businessId,
    telnyx_messaging_campaign_status: input.status,
    telnyx_messaging_campaign_last_attempt_at: now,
    updated_at: now
  };
  if (input.campaignId !== undefined) {
    row.telnyx_messaging_campaign_id = input.campaignId;
  }
  if (input.status === "registered") {
    row.telnyx_messaging_campaign_attached_at = now;
    row.telnyx_messaging_campaign_last_error = null;
  } else if (input.lastError !== undefined) {
    row.telnyx_messaging_campaign_last_error = input.lastError;
  }
  const { data, error } = await db
    .from("business_telnyx_settings")
    .upsert(row, { onConflict: "business_id" })
    .select()
    .single();
  if (error) {
    throw new Error(`setBusinessMessagingCampaignStatus: ${error.message}`);
  }
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
