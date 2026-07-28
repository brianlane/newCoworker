/**
 * Prospecting — DB access for the settings row and the outreach ledger.
 *
 * `outreach_settings` holds one row per business (mode, targeting, cap, send
 * window, sending mailbox); `outreach_prospects` is the permanent ledger of
 * every domain we have discovered for that business. Both tables are
 * service-role-only (RLS on, no policies) — every access flows through the
 * Next.js server after its own auth checks, matching email_campaigns.
 *
 * The ledger is append-and-advance, never delete: a row's existence is what
 * suppresses its domain from ever being discovered again, whatever became of
 * it. See the migration header for why suppression is wider than sending.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { PG_UNIQUE_VIOLATION } from "@/lib/customer-memory/db";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Off = the sweep never picks the business up. Manual = draft and wait for
 * the owner. Auto = draft and send inside the cap and window.
 */
export type OutreachMode = "off" | "manual" | "auto";

export type OutreachProspectStatus =
  | "discovered"
  | "drafted"
  | "queued"
  | "sent"
  | "replied"
  | "booked"
  | "unsubscribed"
  | "skipped"
  | "failed";

export type OutreachSettingsRow = {
  business_id: string;
  mode: OutreachMode;
  search_terms: string[];
  cities: string[];
  daily_cap: number;
  send_window_start_hour: number;
  send_window_end_hour: number;
  from_connection_id: string | null;
  /** CAN-SPAM postal address. The DB refuses a non-off mode without one. */
  postal_address: string | null;
  value_prop: string | null;
  sender_name: string | null;
  last_discovery_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OutreachProspectRow = {
  id: string;
  business_id: string;
  domain: string;
  business_name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  vertical: string;
  city: string;
  findings: Array<{ code: string; detail: string }>;
  pitch_subject: string | null;
  pitch_body: string | null;
  status: OutreachProspectStatus;
  status_detail: string | null;
  contact_id: string | null;
  drafted_at: string | null;
  queued_at: string | null;
  sent_at: string | null;
  /** One follow-up per prospect, ever; this stamp is what enforces it. */
  nudged_at: string | null;
  replied_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Sends per UTC day when a business has not chosen its own cap. */
export const OUTREACH_DEFAULT_DAILY_CAP = 12;

/** Bound on any single ledger scan, so one enormous tenant cannot stall a pass. */
export const OUTREACH_SCAN_LIMIT = 1000;

export async function getOutreachSettings(
  businessId: string,
  client?: SupabaseClient
): Promise<OutreachSettingsRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_settings")
    .select()
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getOutreachSettings: ${error.message}`);
  return (data as OutreachSettingsRow | null) ?? null;
}

export type OutreachSettingsPatch = Partial<
  Pick<
    OutreachSettingsRow,
    | "mode"
    | "search_terms"
    | "cities"
    | "daily_cap"
    | "send_window_start_hour"
    | "send_window_end_hour"
    | "from_connection_id"
    | "postal_address"
    | "value_prop"
    | "sender_name"
    | "last_discovery_at"
  >
>;

/**
 * Create or update the business's settings row. Upsert rather than update:
 * the row does not exist until the owner first touches Prospecting, and the
 * defaults in the migration (mode 'off') are what a missing row means.
 */
export async function upsertOutreachSettings(
  businessId: string,
  patch: OutreachSettingsPatch,
  client?: SupabaseClient
): Promise<OutreachSettingsRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_settings")
    .upsert(
      { business_id: businessId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: "business_id" }
    )
    .select()
    .single();
  if (error) throw new Error(`upsertOutreachSettings: ${error.message}`);
  return data as OutreachSettingsRow;
}

/** Every business the feature is switched on for (the sweep's outer loop). */
export async function listActiveOutreachSettings(
  client?: SupabaseClient
): Promise<OutreachSettingsRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_settings")
    .select()
    .neq("mode", "off")
    .order("updated_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`listActiveOutreachSettings: ${error.message}`);
  return (data ?? []) as OutreachSettingsRow[];
}

/**
 * Insert newly discovered prospects, ignoring domains already in the ledger.
 * Returns the rows that were actually created, so a caller can report "3 new"
 * honestly instead of counting what it offered.
 */
export async function insertProspects(
  rows: Array<
    Pick<OutreachProspectRow, "business_id" | "domain"> &
      Partial<
        Pick<
          OutreachProspectRow,
          "business_name" | "email" | "phone" | "website" | "vertical" | "city"
        >
      >
  >,
  client?: SupabaseClient
): Promise<OutreachProspectRow[]> {
  if (rows.length === 0) return [];
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .upsert(rows, { onConflict: "business_id,domain", ignoreDuplicates: true })
    .select();
  if (error) throw new Error(`insertProspects: ${error.message}`);
  return (data ?? []) as OutreachProspectRow[];
}

/**
 * Domains of this business already in the ledger, whatever their status.
 * Discovery calls this BEFORE probing, so a suppressed domain costs no
 * network I/O rather than being filtered at insert time.
 */
export async function existingProspectDomains(
  businessId: string,
  domains: string[],
  client?: SupabaseClient
): Promise<Set<string>> {
  if (domains.length === 0) return new Set();
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .select("domain")
    .eq("business_id", businessId)
    .in("domain", domains);
  if (error) throw new Error(`existingProspectDomains: ${error.message}`);
  return new Set(((data as Array<{ domain: string }> | null) ?? []).map((r) => r.domain));
}

export async function listProspectsByStatus(
  businessId: string,
  statuses: OutreachProspectStatus[],
  limit: number,
  client?: SupabaseClient
): Promise<OutreachProspectRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .select()
    .eq("business_id", businessId)
    .in("status", statuses)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listProspectsByStatus: ${error.message}`);
  return (data ?? []) as OutreachProspectRow[];
}

export async function getProspect(
  businessId: string,
  prospectId: string,
  client?: SupabaseClient
): Promise<OutreachProspectRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .select()
    .eq("business_id", businessId)
    .eq("id", prospectId)
    .maybeSingle();
  if (error) throw new Error(`getProspect: ${error.message}`);
  return (data as OutreachProspectRow | null) ?? null;
}

/**
 * The prospect this address belongs to, if any. Used when a reply or an
 * unsubscribe arrives and all we know is who sent it.
 */
export async function findProspectByEmail(
  businessId: string,
  email: string,
  client?: SupabaseClient
): Promise<OutreachProspectRow | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .select()
    .eq("business_id", businessId)
    .ilike("email", normalized)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findProspectByEmail: ${error.message}`);
  return (data as OutreachProspectRow | null) ?? null;
}

/**
 * Prospects sent to a while ago with no reply and no nudge yet: the one
 * follow-up each, oldest first. `sentBefore` is the patience window and
 * `sentAfter` the staleness floor, because nudging a two-month-old cold email
 * reads as a stranger rediscovering you rather than a follow-up.
 */
export async function listProspectsDueForNudge(
  businessId: string,
  sentAfterIso: string,
  sentBeforeIso: string,
  limit: number,
  client?: SupabaseClient
): Promise<OutreachProspectRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .select()
    .eq("business_id", businessId)
    .eq("status", "sent")
    .is("nudged_at", null)
    .gte("sent_at", sentAfterIso)
    .lte("sent_at", sentBeforeIso)
    .order("sent_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listProspectsDueForNudge: ${error.message}`);
  return (data ?? []) as OutreachProspectRow[];
}

export type OutreachProspectPatch = Partial<
  Pick<
    OutreachProspectRow,
    | "business_name"
    | "email"
    | "phone"
    | "website"
    | "vertical"
    | "findings"
    | "pitch_subject"
    | "pitch_body"
    | "status"
    | "status_detail"
    | "contact_id"
    | "drafted_at"
    | "queued_at"
    | "sent_at"
    | "nudged_at"
    | "replied_at"
  >
>;

/**
 * Apply a patch. Returns false when the write hit the address-axis unique
 * index (this address already fronts another prospect of this business), so
 * the caller can retire the duplicate instead of crashing the pass: the
 * partial index on lower(email) is a real constraint the probe discovers
 * late, since discovery finds domains and only probing finds addresses.
 */
export async function patchProspect(
  businessId: string,
  prospectId: string,
  patch: OutreachProspectPatch,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("outreach_prospects")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", prospectId);
  if (!error) return true;
  if (error.code === PG_UNIQUE_VIOLATION) return false;
  throw new Error(`patchProspect: ${error.message}`);
}

/**
 * Guarded status transition: applies `patch` only while the prospect is still
 * in `fromStatus`. Returns whether a row actually moved — this is the claim
 * that keeps two overlapping sweeps (or a sweep racing an owner's Send press)
 * from queueing one prospect twice. Same shape as transitionEmailCampaign,
 * and for the same reason: at-most-once is the right bias for cold mail.
 */
export async function transitionProspect(
  businessId: string,
  prospectId: string,
  fromStatus: OutreachProspectStatus,
  patch: OutreachProspectPatch,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", prospectId)
    .eq("status", fromStatus)
    .select("id");
  if (error) throw new Error(`transitionProspect: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Sends already made in the current window — half the daily-cap numerator. */
export async function countProspectsSentSince(
  businessId: string,
  sinceIso: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("outreach_prospects")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .gte("sent_at", sinceIso);
  if (error) throw new Error(`countProspectsSentSince: ${error.message}`);
  return count ?? 0;
}

/**
 * Follow-ups already sent in the current window. The other half of the cap: a
 * nudge is a cold email too, so the tenant's daily limit has to count it, or a
 * day at the cap can still emit a batch of follow-ups every tick.
 */
export async function countProspectsNudgedSince(
  businessId: string,
  sinceIso: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("outreach_prospects")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .gte("nudged_at", sinceIso);
  if (error) throw new Error(`countProspectsNudgedSince: ${error.message}`);
  return count ?? 0;
}

/**
 * Status + vertical for every prospect of this business, for the funnel the
 * owner surface renders. Bounded like the campaign audience scan: the
 * aggregation itself is a pure function (see stats.ts) so it stays testable
 * without a database.
 */
export async function listProspectOutcomes(
  businessId: string,
  client?: SupabaseClient
): Promise<Array<{ status: OutreachProspectStatus; vertical: string }>> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .select("status, vertical")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(OUTREACH_SCAN_LIMIT);
  if (error) throw new Error(`listProspectOutcomes: ${error.message}`);
  return (data ?? []) as Array<{ status: OutreachProspectStatus; vertical: string }>;
}
