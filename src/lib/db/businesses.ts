import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { Business } from "@/lib/db/schema";
import type { EnterpriseLimitsOverride } from "@/lib/plans/enterprise-limits";
import { createPendingOwnerEmail } from "@/lib/onboarding/token";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BusinessRow = {
  id: string;
  name: string;
  owner_email: string;
  tier: "starter" | "standard" | "enterprise";
  /**
   * `wiped` is a terminal state set by the subscription-grace-sweep after a
   * canceled subscription's 30-day retention window expires. See the
   * lifecycle plan and migration 20260501000000_subscription_lifecycle.
   */
  status: "online" | "offline" | "high_load" | "wiped";
  hostinger_vps_id: string | null;
  created_at: string;
  is_paused?: boolean;
  /**
   * Safe Mode flag. When `false`, inbound customer SMS/voice is forwarded to
   * `business_telnyx_settings.forward_to_e164` instead of being handled by the
   * AI. Distinct from `is_paused`: Safe Mode keeps the VPS and owner chat
   * fully online.
   */
  customer_channels_enabled?: boolean;
  /** Enterprise tier only: partial TierLimits JSON; merged with defaults in app + Edge. */
  enterprise_limits?: Record<string, unknown> | null;
  /** Lifetime abuse-tracking profile — null for pre-lifecycle businesses. */
  customer_profile_id?: string | null;
  /**
   * Industry slug chosen during onboarding (e.g. "real_estate"). Drives
   * per-industry behavior such as compliance guardrails and AiFlow example
   * copy. Null for pre-onboarding / legacy rows.
   */
  business_type?: string | null;
  /**
   * Owner phone number captured during onboarding. May be free-form (no
   * country code, formatting characters) — coerce via
   * `coerceOwnerPhoneToE164` before persisting downstream.
   */
  phone?: string | null;
  /**
   * IANA timezone (e.g. "America/Phoenix") used for AI date/time context
   * and calendar tool defaults. Null = UTC fallback. Captured from the
   * owner's browser at onboarding; editable in Settings.
   */
  timezone?: string | null;
  /**
   * Hardware pin (Hostinger box size), decoupled from `tier` (entitlements).
   * Null = tier default (starter→kvm2, standard→kvm8). Resolved via
   * `resolveVpsSize` in src/lib/vps/size.ts.
   */
  vps_size?: "kvm2" | "kvm8" | null;
};

/**
 * True when `tz` is an IANA timezone name the runtime can actually format
 * with — the only validation that matters, since `Intl.DateTimeFormat` is
 * exactly what consumes the value downstream.
 */
export function isValidIanaTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function createBusiness(
  data: {
    id: string;
    name: string;
    ownerEmail: string;
    tier: Business["tier"];
    businessType?: string;
    ownerName?: string;
    phone?: string;
    websiteUrl?: string;
    serviceArea?: string;
    typicalInquiry?: string;
    teamSize?: number;
    crmUsed?: string;
    /** IANA timezone auto-detected from the owner's browser at onboarding. */
    timezone?: string;
  },
  client?: SupabaseClient
): Promise<BusinessRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("businesses")
    .insert({
      id: data.id,
      name: data.name,
      owner_email: data.ownerEmail,
      tier: data.tier,
      status: "offline",
      business_type: data.businessType ?? null,
      owner_name: data.ownerName ?? null,
      phone: data.phone ?? null,
      website_url: data.websiteUrl ?? null,
      service_area: data.serviceArea ?? null,
      typical_inquiry: data.typicalInquiry ?? null,
      team_size: data.teamSize ?? null,
      crm_used: data.crmUsed ?? null,
      timezone: data.timezone ?? null
    })
    .select()
    .single();

  if (error) throw new Error(`createBusiness: ${error.message}`);
  return row as BusinessRow;
}

export async function updateBusinessWebsiteUrl(
  id: string,
  websiteUrl: string | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ website_url: websiteUrl })
    .eq("id", id);
  if (error) throw new Error(`updateBusinessWebsiteUrl: ${error.message}`);
}

export async function getBusiness(id: string, client?: SupabaseClient): Promise<BusinessRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select()
    .eq("id", id)
    .single();

  if (error) return null;
  return data as BusinessRow;
}

/**
 * Ids of every business owned by `ownerEmail` (newest first). Businesses are
 * keyed by `owner_email` (no stable owner_user_id), so this is the canonical
 * "businesses of the signed-in user" lookup. Throws on a query error — the
 * checkout guard that calls this must fail closed, not open.
 */
export async function listBusinessIdsByOwnerEmail(
  ownerEmail: string,
  client?: SupabaseClient
): Promise<string[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("id")
    .eq("owner_email", ownerEmail)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listBusinessIdsByOwnerEmail: ${error.message}`);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

export async function deleteBusiness(id: string, client?: SupabaseClient): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").delete().eq("id", id);
  if (error) throw new Error(`deleteBusiness: ${error.message}`);
}

export async function listBusinesses(client?: SupabaseClient): Promise<BusinessRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select()
    .order("created_at", { ascending: false });

  if (error) throw new Error(`listBusinesses: ${error.message}`);
  return (data ?? []) as BusinessRow[];
}

export async function updateBusinessStatus(
  id: string,
  status: BusinessRow["status"],
  vpsId?: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const update: Record<string, string> = { status };
  if (vpsId) update["hostinger_vps_id"] = vpsId;

  const { error } = await db.from("businesses").update(update).eq("id", id);
  if (error) throw new Error(`updateBusinessStatus: ${error.message}`);
}

export async function setBusinessPaused(
  id: string,
  paused: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ is_paused: paused }).eq("id", id);
  if (error) throw new Error(`setBusinessPaused: ${error.message}`);
}

export async function setCustomerChannelsEnabled(
  id: string,
  enabled: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ customer_channels_enabled: enabled })
    .eq("id", id);
  if (error) throw new Error(`setCustomerChannelsEnabled: ${error.message}`);
}

/**
 * Pin (or unpin, with null) the hardware size for a business. Takes effect on
 * the NEXT provisioning run (plan change, resubscribe, or an explicit
 * migration via debug/migrate-vps-size.ts) — it does not move a live VPS.
 */
export async function updateBusinessVpsSize(
  id: string,
  vpsSize: "kvm2" | "kvm8" | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ vps_size: vpsSize }).eq("id", id);
  if (error) throw new Error(`updateBusinessVpsSize: ${error.message}`);
}

export async function updateEnterpriseLimits(
  id: string,
  limits: EnterpriseLimitsOverride | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ enterprise_limits: limits }).eq("id", id);
  if (error) throw new Error(`updateEnterpriseLimits: ${error.message}`);
}

export async function updateBusinessOwnerEmail(
  id: string,
  ownerEmail: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ owner_email: ownerEmail }).eq("id", id);
  if (error) throw new Error(`updateBusinessOwnerEmail: ${error.message}`);
}

export async function updateBusinessName(
  id: string,
  name: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ name }).eq("id", id);
  if (error) throw new Error(`updateBusinessName: ${error.message}`);
}

export async function updateBusinessTimezone(
  id: string,
  timezone: string | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ timezone }).eq("id", id);
  if (error) throw new Error(`updateBusinessTimezone: ${error.message}`);
}

/**
 * Light single-column read for the calendar tools' timezone default.
 * Returns null when unset or on any read error (degrade to UTC, never
 * fail the tool call over a timezone lookup).
 */
export async function getBusinessTimezone(
  id: string,
  client?: SupabaseClient
): Promise<string | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("timezone")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const tz = (data as { timezone?: string | null }).timezone;
  return typeof tz === "string" && tz.trim().length > 0 ? tz : null;
}

export async function setBusinessCustomerProfile(
  id: string,
  customerProfileId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ customer_profile_id: customerProfileId })
    .eq("id", id);
  if (error) throw new Error(`setBusinessCustomerProfile: ${error.message}`);
}

export async function updateBusinessOwnerEmailIfPending(
  id: string,
  ownerEmail: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const pendingOwnerEmail = createPendingOwnerEmail(id);
  const { data, error } = await db
    .from("businesses")
    .update({ owner_email: ownerEmail })
    .eq("id", id)
    .eq("owner_email", pendingOwnerEmail)
    .select("id");

  if (error) {
    throw new Error(`updateBusinessOwnerEmailIfPending: ${error.message}`);
  }

  if ((data ?? []).length > 0) {
    return true;
  }

  const business = await getBusiness(id, db);

  if (!business) {
    return false;
  }

  return business.owner_email === ownerEmail;
}
