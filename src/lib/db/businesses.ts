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
};

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
      crm_used: data.crmUsed ?? null
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
