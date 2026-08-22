import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { Business } from "@/lib/db/schema";
import type { EnterpriseLimitsOverride } from "@/lib/plans/enterprise-limits";
import type { Branding } from "@/lib/plans/branding";
import type { EnterpriseModels } from "@/lib/plans/enterprise-models";
import type { ComplianceModule } from "@/lib/compliance/module";
import {
  assertResidencyModeAllowed,
  residencyAllowedForTier,
  RESIDENCY_TIER_MESSAGE,
  ResidencyValidationError,
  type DataResidencyMode
} from "@/lib/residency/tier-gate";
import { assertResidencyReplayCronScheduled } from "@/lib/residency/keep-window";
import { assertHipaaModeAllowed } from "@/lib/hipaa/tier-gate";
import {
  assertVpsProviderAllowed,
  type VpsProvider,
  type VpsRegion
} from "@/lib/vps/provider";
import { createPendingOwnerEmail } from "@/lib/onboarding/token";
import { attachProspectWhiteGloveOffersToBusiness } from "@/lib/db/white-glove-offers";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type BusinessRow = {
  id: string;
  name: string;
  owner_email: string;
  /** Owner display name captured at onboarding; null on legacy rows. */
  owner_name?: string | null;
  tier: "starter" | "standard" | "enterprise";
  /**
   * `wiped` is a terminal state set by the subscription-grace-sweep after a
   * canceled subscription's 30-day retention window expires. See the
   * lifecycle plan and migration 20260501000000_subscription_lifecycle.
   */
  status: "online" | "offline" | "high_load" | "wiped";
  hostinger_vps_id: string | null;
  /**
   * Hostinger BILLING subscription id for the box, distinct from the VM id.
   * Non-null means hardware has been paid for even when `hostinger_vps_id` is
   * not yet stamped (the purchase can return before the VM is recorded), so
   * the abandoned-signup sweep treats it as VPS linkage.
   */
  hostinger_subscription_id?: string | null;
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
  /** Lifetime abuse-tracking profile, null for pre-lifecycle businesses. */
  customer_profile_id?: string | null;
  /** Admin dashboard mutes, hide this business from the fleet-wide feeds
   *  (Recent Activity / System Errors / Recent Alerts). Managed via
   *  src/lib/db/admin-mutes.ts. */
  admin_mute_activity?: boolean;
  admin_mute_errors?: boolean;
  admin_mute_alerts?: boolean;
  /** Pinned to the top of the admin All Clients table (admin-facing only). */
  admin_pinned?: boolean;
  /**
   * Industry slug chosen during onboarding (e.g. "real_estate"). Drives
   * per-industry behavior such as compliance guardrails and AiFlow example
   * copy. Null for pre-onboarding / legacy rows.
   */
  business_type?: string | null;
  /**
   * Owner phone number captured during onboarding. May be free-form (no
   * country code, formatting characters), coerce via
   * `coerceOwnerPhoneToE164` before persisting downstream.
   */
  phone?: string | null;
  /**
   * Optional 3-digit NANP area code the owner requested at signup for their
   * AI coworker's number. Highest-priority hint for the auto-purchase DID
   * search cascade (requested → owner-phone-derived → platform default);
   * null = no explicit preference. DB check enforces `^[2-9][0-9]{2}$`.
   */
  preferred_area_code?: string | null;
  /**
   * IANA timezone (e.g. "America/Phoenix") used for AI date/time context
   * and calendar tool defaults. Null = UTC fallback. Captured from the
   * owner's browser at onboarding; editable in Settings.
   */
  timezone?: string | null;
  /** Free-form street address shown to customers (Settings → Business profile). */
  address?: string | null;
  /**
   * Owner opt-in: attach a Google Meet link to appointments booked onto a
   * connected Google Calendar. Default false, because Google is already
   * connected for mail and calendar by tenants who never asked for video.
   * Zoom wins when a zoom_connections row is active, so this only decides
   * the no-Zoom case. See src/lib/google/meet.ts.
   */
  google_meet_enabled?: boolean;
  /**
   * Per-day open/close windows (Settings → Business profile). Shape is
   * validated app-side, see src/lib/business-profile/profile.ts. Rendered
   * into business_configs.profile_md for prompt composition.
   */
  business_hours?: Record<string, unknown> | null;
  /**
   * Hardware pin (Hostinger box size), decoupled from `tier` (entitlements).
   * Null = tier default. Resolved via `resolveVpsSize` (new provisions) /
   * `resolveDeployedVpsSize` (existing boxes) in src/lib/vps/size.ts.
   */
  vps_size?: "kvm1" | "kvm2" | "kvm4" | "kvm8" | null;
  /**
   * Provider axis (default 'hostinger'). 'ovh' (platform-owned Canada box)
   * and 'byos' (customer-owned, SSH handover) are enterprise-only, enforced
   * in src/lib/vps/provider.ts. Missing/legacy rows resolve to 'hostinger'
   * via resolveVpsProvider.
   */
  vps_provider?: "hostinger" | "ovh" | "byos" | null;
  /**
   * Physical region of the tenant box (default 'us'). 'ca' = Canadian data
   * residency (OVH Beauharnois or a Canadian BYOS box).
   */
  vps_region?: "us" | "ca" | null;
  /**
   * Where encrypted residency dumps go (default 'central'): 'central' =
   * ciphertext to central Supabase Storage; 'onbox' = dumps stay on the
   * tenant box (in-region even for ciphertext, Canadian/insurance deals).
   */
  residency_backup_destination?: "central" | "onbox" | null;
  /**
   * Enterprise-only data-residency rollout gate (default 'supabase').
   * 'dual' = both stores written during migration; 'vps' = the tenant's box
   * is the content source of truth. Written only via updateDataResidencyMode,
   * which enforces the enterprise tier gate.
   */
  data_residency_mode?: DataResidencyMode;
  /**
   * Enterprise-only HIPAA lane opt-in (default false). When true the tenant
   * may only provision onto a HIPAA-eligible placement with residency at
   * least 'dual' (src/lib/hipaa/placement.ts). Written only via
   * updateBusinessHipaaMode, which enforces the enterprise tier gate.
   */
  hipaa_mode?: boolean;
  /**
   * Content-history retention window in days (min 30, DB check enforced).
   * Null = keep forever (default). Swept daily by data-retention-sweep →
   * pruneExpiredContent; contacts are exempt (the deletion tool handles
   * full per-person erasure).
   */
  data_retention_days?: number | null;
  /**
   * Highest white-glove onboarding package purchased (Phase C5). Recorded by
   * the Stripe webhook; catalog in src/lib/plans/white-glove.ts.
   */
  white_glove_package?: "setup" | "buildout" | null;
  white_glove_purchased_at?: string | null;
  /**
   * Priority call/video support window end. Opened by a white-glove purchase
   * (+30d), by the $400/month priority support subscription (each paid invoice
   * pushes it to that period's end + grace), or by an admin comp.
   * Null or past = email-only support. Gate via `hasPrioritySupport`.
   */
  priority_support_until?: string | null;
  /**
   * When the priority-support expiry warning was last emailed. Stamped BEFORE
   * the send so an overlapping sweep cannot double-email; cleared when a new
   * coverage window opens so the next lapse warns again.
   */
  priority_support_nudge_sent_at?: string | null;
};

/**
 * True when `tz` is an IANA timezone name the runtime can actually format
 * with, the only validation that matters, since `Intl.DateTimeFormat` is
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
    /** Normalized 3-digit NPA or omitted, callers validate via `normalizePreferredAreaCode`. */
    preferredAreaCode?: string | null;
    websiteUrl?: string;
    serviceArea?: string;
    typicalInquiry?: string;
    teamSize?: number;
    crmUsed?: string;
    /** IANA timezone auto-detected from the owner's browser at onboarding. */
    timezone?: string;
    /**
     * Coworker's opening language with customers. Omitted means the column
     * default ('en'); Mexican signups pass 'es' (see /api/business/create).
     */
    defaultCustomerLanguage?: "en" | "es";
    /**
     * Optional hardware pin recorded at creation (admin enterprise flow).
     * Null = tier default at provision time (see DEFAULT_TIER_VPS_SIZE).
     */
    vpsSize?: "kvm1" | "kvm2" | "kvm4" | "kvm8" | null;
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
      preferred_area_code: data.preferredAreaCode ?? null,
      website_url: data.websiteUrl ?? null,
      service_area: data.serviceArea ?? null,
      typical_inquiry: data.typicalInquiry ?? null,
      team_size: data.teamSize ?? null,
      crm_used: data.crmUsed ?? null,
      timezone: data.timezone ?? null,
      vps_size: data.vpsSize ?? null,
      // Only sent when a caller chose one so the column default keeps
      // governing every other signup.
      ...(data.defaultCustomerLanguage
        ? { default_customer_language: data.defaultCustomerLanguage }
        : {})
    })
    .select()
    .single();

  if (error) throw new Error(`createBusiness: ${error.message}`);
  const business = row as BusinessRow;

  // A prospect who paid a custom white-glove offer BEFORE signing up gets it
  // attached to the new business automatically (and their priority-support
  // window opened). Best-effort: a hiccup here must never fail account
  // creation, the offer stays attachable by re-running the attach.
  try {
    await attachProspectWhiteGloveOffersToBusiness(business.id, data.ownerEmail, db);
  } catch (err) {
    console.error(
      `createBusiness: attaching prospect white-glove offers failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // A prospect who COMPLETED the white-glove questionnaire gets the 30-day
  // priority support window even if they never bought a package: that is what
  // the onboarding copy promises them. Idempotent, so re-running this is safe.
  try {
    const { attachIntakePrioritySupportToBusiness } = await import("@/lib/white-glove/intake");
    await attachIntakePrioritySupportToBusiness(business.id, data.ownerEmail, db);
  } catch (err) {
    console.error(
      `createBusiness: intake priority support grant failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return business;
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

/**
 * Whether this tenant wants a Google Meet link on Google-calendar bookings.
 *
 * Fails CLOSED: an unreadable row answers false, so a DB hiccup degrades to
 * "book without a video link" rather than sending `conferenceData` on a
 * tenant who never opted in. That is the same direction the whole Meet path
 * degrades in, and the cheap column read keeps it off the booking hot path's
 * critical failure surface.
 */
export async function isGoogleMeetEnabled(
  id: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("google_meet_enabled")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return false;
  return (data as { google_meet_enabled?: unknown }).google_meet_enabled === true;
}

export async function updateGoogleMeetEnabled(
  id: string,
  enabled: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ google_meet_enabled: enabled })
    .eq("id", id);
  if (error) throw new Error(`updateGoogleMeetEnabled: ${error.message}`);
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
 * Strict existence check for a business row. Unlike `getBusiness` (which
 * collapses every error into `null`), a query error here THROWS so security
 * gates can fail closed, the onboarding-draft first-claim gate must not
 * treat "the lookup errored" as "the business does not exist", or a
 * transient DB failure would reopen the unauthenticated pre-claim window
 * it guards (audit 2026-07, finding L3).
 */
export async function businessExists(id: string, client?: SupabaseClient): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("id")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`businessExists: ${error.message}`);
  return data !== null;
}

/**
 * Ids of every business owned by `ownerEmail` (newest first). Businesses are
 * keyed by `owner_email` (no stable owner_user_id), so this is the canonical
 * "businesses of the signed-in user" lookup. Throws on a query error, the
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

/**
 * Backfill the signup-requested DID area code on an existing row (the
 * idempotent business.create retry path, mirrors the timezone backfill).
 * Callers pass a value already normalized by `normalizePreferredAreaCode`.
 */
export async function updateBusinessPreferredAreaCode(
  id: string,
  preferredAreaCode: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ preferred_area_code: preferredAreaCode })
    .eq("id", id);
  if (error) throw new Error(`updateBusinessPreferredAreaCode: ${error.message}`);
}

export async function deleteBusiness(id: string, client?: SupabaseClient): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").delete().eq("id", id);
  if (error) throw new Error(`deleteBusiness: ${error.message}`);
}

/**
 * Every business row currently pointing at a Hostinger VM id. Normally zero
 * or one row; more than one (or a row for a box someone else now owns) means
 * stale linkage, e.g. an admin released the box to the `vps_inventory` pool
 * while the old account still referenced it. Consumed by the adopt-time
 * stale-tenant cleanup (src/lib/provisioning/stale-tenant-cleanup.ts).
 */
export async function listBusinessesByHostingerVpsId(
  vpsId: string,
  client?: SupabaseClient
): Promise<BusinessRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select()
    .eq("hostinger_vps_id", vpsId);
  if (error) throw new Error(`listBusinessesByHostingerVpsId: ${error.message}`);
  return (data ?? []) as BusinessRow[];
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

export async function setBusinessAdminPinned(
  id: string,
  pinned: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ admin_pinned: pinned }).eq("id", id);
  if (error) throw new Error(`setBusinessAdminPinned: ${error.message}`);
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
 * migration via debug/migrate-vps-size.ts), it does not move a live VPS.
 */
export async function updateBusinessVpsSize(
  id: string,
  vpsSize: "kvm1" | "kvm2" | "kvm4" | "kvm8" | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ vps_size: vpsSize }).eq("id", id);
  if (error) throw new Error(`updateBusinessVpsSize: ${error.message}`);
}

/**
 * Pin (or revert) the provider/region axis for a business. Non-hostinger
 * providers are enterprise-only, the gate runs server-side here so every
 * caller (admin route, future flows) is covered, same pattern as
 * updateDataResidencyMode. Reverting to 'hostinger' is always allowed so a
 * downgraded tenant can never be wedged on a provider its plan no longer
 * supports.
 */
export async function updateBusinessVpsProvider(
  id: string,
  provider: VpsProvider,
  region: VpsRegion,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const business = await getBusiness(id, db);
  if (!business) throw new Error(`updateBusinessVpsProvider: business ${id} not found`);
  assertVpsProviderAllowed(provider, business.tier);
  const { error } = await db
    .from("businesses")
    .update({ vps_provider: provider, vps_region: region })
    .eq("id", id);
  if (error) throw new Error(`updateBusinessVpsProvider: ${error.message}`);
}

/**
 * Records a completed white-glove package checkout on the business row and
 * opens the priority call/video support window. Idempotent by construction:
 * webhook retries re-write the same values (session `created` is fixed).
 */
export async function recordWhiteGlovePurchase(
  id: string,
  data: {
    packageId: "setup" | "buildout";
    purchasedAt: Date;
    prioritySupportUntil: Date;
  },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({
      white_glove_package: data.packageId,
      white_glove_purchased_at: data.purchasedAt.toISOString(),
      priority_support_until: data.prioritySupportUntil.toISOString()
    })
    .eq("id", id);
  if (error) throw new Error(`recordWhiteGlovePurchase: ${error.message}`);
}

/**
 * Set the priority support window to an exact value, or clear it with null.
 *
 * Deliberately NOT monotonic, unlike `extendPrioritySupport` (white-glove-
 * offers.ts), which only ever moves the window forward. That guarantee is
 * right for the payment paths, where a webhook retry or an overlapping window
 * must never shorten coverage a tenant paid for. It is wrong for an operator
 * comping support by hand, who has to be able to shorten a window set by
 * mistake or revoke one entirely.
 *
 * So the split is: payment paths call extendPrioritySupport, admin calls this.
 * Do not use this one from a webhook.
 */
export async function setPrioritySupportUntil(
  id: string,
  until: Date | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ priority_support_until: until ? until.toISOString() : null })
    .eq("id", id);
  if (error) throw new Error(`setPrioritySupportUntil: ${error.message}`);
}

/**
 * Clear the expiry-nudge stamp so a NEW coverage window can warn again.
 * Without this, a tenant who lets support lapse and later restarts it would
 * never get a second warning, because the sweep treats a non-null stamp as
 * "already told them".
 */
export async function clearPrioritySupportNudgeStamp(
  id: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ priority_support_nudge_sent_at: null })
    .eq("id", id);
  if (error) throw new Error(`clearPrioritySupportNudgeStamp: ${error.message}`);
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

/** Designated models + voice (enterprise); null clears to platform defaults. */
export async function updateEnterpriseModels(
  id: string,
  models: EnterpriseModels | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ enterprise_models: models }).eq("id", id);
  if (error) throw new Error(`updateEnterpriseModels: ${error.message}`);
}

/** Custom compliance module (enterprise); null clears to platform guardrails. */
export async function updateComplianceModule(
  id: string,
  module: ComplianceModule | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ compliance_module: module })
    .eq("id", id);
  if (error) throw new Error(`updateComplianceModule: ${error.message}`);
}

/** White-label branding (enterprise); null clears back to platform branding. */
export async function updateBusinessBranding(
  id: string,
  branding: Branding | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ branding }).eq("id", id);
  if (error) throw new Error(`updateBusinessBranding: ${error.message}`);
}

/**
 * Flip a tenant's data-residency rollout mode. Enterprise-only for any
 * forward mode; flipping BACK to 'supabase' is always allowed (see
 * assertResidencyModeAllowed) so a downgraded tenant can never be wedged.
 *
 * Moving FORWARD also requires the replay cron to be running. It is
 * currently unscheduled by design (zero residency tenants), and 'dual'
 * replicates nothing without it: the journal just grows. README step 0 said
 * to re-schedule it first and nothing enforced that, so this path happily
 * offered a flip that silently did no replication at all.
 */
export async function updateDataResidencyMode(
  id: string,
  mode: DataResidencyMode,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  await assertResidencyModeAllowed(id, mode, db);
  await assertResidencyReplayCronScheduled(db, mode);
  const { error } = await db
    .from("businesses")
    .update({ data_residency_mode: mode })
    .eq("id", id);
  if (error) throw new Error(`updateDataResidencyMode: ${error.message}`);
}

/**
 * Flip a tenant into or out of the HIPAA lane. Enterprise-only to turn ON;
 * turning OFF is always allowed (see assertHipaaModeAllowed) so a downgraded
 * tenant can never be wedged. Placement is enforced separately at provision
 * time (src/lib/hipaa/placement.ts) rather than here, because a tenant is
 * legitimately flipped on BEFORE its box is moved.
 */
export async function updateBusinessHipaaMode(
  id: string,
  enabled: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  await assertHipaaModeAllowed(id, enabled, db);
  const { error } = await db.from("businesses").update({ hipaa_mode: enabled }).eq("id", id);
  if (error) throw new Error(`updateBusinessHipaaMode: ${error.message}`);
}

/**
 * Flip where a tenant's encrypted residency dumps go. Enterprise-only for
 * 'onbox' (it is a residency-program lever); reverting to the 'central'
 * default is always allowed so a downgraded tenant can never be wedged.
 * Takes effect on the next deploy (the backup timer's env is rewritten).
 */
export async function updateResidencyBackupDestination(
  id: string,
  destination: "central" | "onbox",
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  await assertOnboxDestinationAllowed(id, destination, db);
  const { error } = await db
    .from("businesses")
    .update({ residency_backup_destination: destination })
    .eq("id", id);
  if (error) throw new Error(`updateResidencyBackupDestination: ${error.message}`);
}

/** Enterprise gate for the 'onbox' flip; 'central' reverts are ungated. */
async function assertOnboxDestinationAllowed(
  id: string,
  destination: "central" | "onbox",
  db: SupabaseClient
): Promise<void> {
  if (destination !== "onbox") return;
  const business = await getBusiness(id, db);
  if (!business) {
    throw new Error(`updateResidencyBackupDestination: business ${id} not found`);
  }
  if (!residencyAllowedForTier(business.tier)) {
    throw new ResidencyValidationError(RESIDENCY_TIER_MESSAGE);
  }
}

/** Floor for the retention window, mirrors the DB check constraint. */
export const MIN_DATA_RETENTION_DAYS = 30;

/**
 * Set (or clear, with null) a tenant's content-history retention window.
 * Admin-only lever (route enforces requireAdmin); the 30-day floor exists
 * so retention can't undercut the billing grace window or delete context
 * the engine still legitimately surfaces.
 */
export async function updateDataRetentionDays(
  id: string,
  retentionDays: number | null,
  client?: SupabaseClient
): Promise<void> {
  if (
    retentionDays !== null &&
    (!Number.isInteger(retentionDays) || retentionDays < MIN_DATA_RETENTION_DAYS)
  ) {
    throw new Error(
      `updateDataRetentionDays: retentionDays must be null or an integer >= ${MIN_DATA_RETENTION_DAYS}`
    );
  }
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ data_retention_days: retentionDays })
    .eq("id", id);
  if (error) throw new Error(`updateDataRetentionDays: ${error.message}`);
}

/**
 * Businesses with a retention window configured, the data-retention-sweep's
 * work list.
 */
export async function listBusinessesWithRetention(
  client?: SupabaseClient
): Promise<Array<{ id: string; data_retention_days: number }>> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("businesses")
    .select("id, data_retention_days")
    .not("data_retention_days", "is", null);
  if (error) throw new Error(`listBusinessesWithRetention: ${error.message}`);
  return (data ?? []) as Array<{ id: string; data_retention_days: number }>;
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

/**
 * Refresh the owner phone (e.g. the checkout retry path syncing a Step 1
 * edit from the token-verified onboarding draft, so fee detection and
 * provisioning read the same value).
 */
export async function updateBusinessPhone(
  id: string,
  phone: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update({ phone }).eq("id", id);
  if (error) throw new Error(`updateBusinessPhone: ${error.message}`);
}

/**
 * Patch the structured business-profile fields (Settings → Business
 * profile). Only provided keys are written; callers validate shapes
 * (hours via parseBusinessHours, industry against BUSINESS_TYPE_LABELS)
 * before calling.
 */
export async function updateBusinessProfileFields(
  id: string,
  patch: {
    phone?: string | null;
    address?: string | null;
    business_type?: string | null;
    business_hours?: Record<string, unknown> | null;
  },
  client?: SupabaseClient
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.phone !== undefined) update.phone = patch.phone;
  if (patch.address !== undefined) update.address = patch.address;
  if (patch.business_type !== undefined) update.business_type = patch.business_type;
  if (patch.business_hours !== undefined) update.business_hours = patch.business_hours;
  if (Object.keys(update).length === 0) return;
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("businesses").update(update).eq("id", id);
  if (error) throw new Error(`updateBusinessProfileFields: ${error.message}`);
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
 * Set the tenant's default customer-facing language ("en" | "es"): what the
 * coworker opens with when a customer's own language is unknown or
 * ambiguous. Every consumer (SMS inbound worker, voice IVR, voice-bridge
 * persona) reads the businesses row live, so the write propagates without a
 * profile refresh or vault sync; per-contact detected language still
 * overrides per person. Until the Mexico rollout this column had readers
 * and no writer (SQL-only), which is exactly what this closes.
 */
export async function updateBusinessDefaultCustomerLanguage(
  id: string,
  language: "en" | "es",
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ default_customer_language: language })
    .eq("id", id);
  if (error) throw new Error(`updateBusinessDefaultCustomerLanguage: ${error.message}`);
}

/**
 * Toggle AiFlow staff-contact tag protection (Settings): when ON (default),
 * update_contact steps skip owner/employee contacts so lead-state tags never
 * land on staff. See migration 20260813000000_aiflow_staff_tag_protection.
 */
export async function setAiflowStaffProtection(
  id: string,
  enabled: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ aiflow_protect_staff_contacts: enabled })
    .eq("id", id);
  if (error) throw new Error(`setAiflowStaffProtection: ${error.message}`);
}

/**
 * Toggle lead auto-assignment (Employees page): when ON, route_to_team
 * hard-assigns each lead to the next roster member in rotation (assignment
 * FYI, no claim handshake). Default OFF = offer-and-claim. See migration
 * 20260713222759_lead_auto_assign.
 */
export async function setLeadAutoAssign(
  id: string,
  enabled: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ lead_auto_assign: enabled })
    .eq("id", id);
  if (error) throw new Error(`setLeadAutoAssign: ${error.message}`);
}

/**
 * Toggle team-first human handoff (Employees page): when ON, a needs-human
 * escalation broadcasts a claim offer to the whole active roster first and
 * pages the owner only when nobody claims within the offer window. Default
 * OFF = page the owner immediately. See migration
 * 20260817120000_needs_human_team_first.
 */
export async function setNeedsHumanTeamFirst(
  id: string,
  enabled: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("businesses")
    .update({ needs_human_team_first: enabled })
    .eq("id", id);
  if (error) throw new Error(`setNeedsHumanTeamFirst: ${error.message}`);
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

  const swapped = (data ?? []).length > 0;
  if (!swapped) {
    const business = await getBusiness(id, db);
    if (!business || business.owner_email !== ownerEmail) return false;
  }

  // Stripe-first onboarding creates the row with a pending sentinel email, so
  // createBusiness's prospect white-glove attach found nothing; the REAL email
  // just landed, re-run the attach now. Best-effort, mirroring createBusiness.
  try {
    await attachProspectWhiteGloveOffersToBusiness(id, ownerEmail, db);
  } catch (err) {
    console.error(
      `updateBusinessOwnerEmailIfPending: prospect white-glove attach failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // Same reason as the offer attach above: createBusiness ran against the
  // pending sentinel email and found no questionnaire, so re-run now that the
  // real address has landed. The grant claim makes the repeat a no-op.
  try {
    const { attachIntakePrioritySupportToBusiness } = await import("@/lib/white-glove/intake");
    await attachIntakePrioritySupportToBusiness(id, ownerEmail, db);
  } catch (err) {
    console.error(
      `updateBusinessOwnerEmailIfPending: intake priority support grant failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return true;
}
