/**
 * Prospecting: DB access for the settings row and the outreach ledger.
 *
 * `outreach_settings` holds one row per business (mode, targeting, cap, send
 * window, sending mailbox); `outreach_prospects` is the permanent ledger of
 * every domain we have discovered for that business. Both tables are
 * service-role-only (RLS on, no policies), so every access flows through the
 * Next.js server after its own auth checks, matching email_campaigns.
 *
 * The ledger is append-and-advance, never delete: a row's existence is what
 * suppresses its domain from ever being discovered again, whatever became of
 * it. See the migration header for why suppression is wider than sending.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { PG_UNIQUE_VIOLATION } from "@/lib/customer-memory/db";
import type { PlacesOpeningHours } from "./discover";
import { UNKNOWN_VERTICAL } from "./stats";

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
  /**
   * CAN-SPAM postal address. The DB refuses a non-off mode without one unless
   * `postal_address_exempt` is set, in which case the footer falls back to the
   * business profile address.
   */
  postal_address: string | null;
  /** The plan waives the typed footer address (Enterprise). Set from the tier. */
  postal_address_exempt: boolean;
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
  /** `places.regularOpeningHours` at discovery; the hours findings prefer it. */
  google_hours: PlacesOpeningHours | null;
  rating: number | null;
  /** Orders the probe queue. Never a filter: see the migration comment. */
  review_count: number | null;
  findings: Array<{ code: string; detail: string }>;
  pitch_subject: string | null;
  /**
   * The editable middle of the draft, blank-line separated. `pitch_body` is
   * this plus the CTA, signature, and compliance footer, assembled in code.
   * Null on rows drafted before the column existed: those can be regenerated
   * but not edited, since there is no owner-safe text to hand back.
   */
  pitch_paragraphs: string | null;
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
    | "postal_address_exempt"
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

/** Businesses read per page by the sweep's outer loop. */
export const OUTREACH_ACTIVE_PAGE_SIZE = 200;

/**
 * One page of the businesses the feature is switched on for.
 *
 * Ordered by business id, not by `updated_at`, and that matters: the sweep
 * stamps `last_discovery_at` as it goes, which moves a row's `updated_at`. With
 * a time ordering, rows would reshuffle underneath the pagination mid-pass and
 * a business could be swept twice or skipped entirely. The id is stable.
 */
export async function listActiveOutreachSettings(
  client?: SupabaseClient,
  offset = 0
): Promise<OutreachSettingsRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_settings")
    .select()
    .neq("mode", "off")
    .order("business_id", { ascending: true })
    .range(offset, offset + OUTREACH_ACTIVE_PAGE_SIZE - 1);
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
          | "business_name"
          | "email"
          | "phone"
          | "website"
          | "vertical"
          | "city"
          | "google_hours"
          | "rating"
          | "review_count"
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

/**
 * Newly discovered prospects to probe and draft next, busiest first.
 *
 * Ordered by review count rather than discovery time: a probe and a draft cost
 * a site fetch and a Gemini call each, and an established business with
 * hundreds of reviews is a better use of both than a listing with two. It only
 * ORDERS. Nothing is excluded on rating or review count, because a thin Google
 * profile is not evidence a business would not want this, and filtering on it
 * would quietly narrow the market to whoever is already doing well.
 */
export async function listProspectsToProbe(
  businessId: string,
  limit: number,
  client?: SupabaseClient
): Promise<OutreachProspectRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .select()
    .eq("business_id", businessId)
    .eq("status", "discovered")
    .order("review_count", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listProspectsToProbe: ${error.message}`);
  return (data ?? []) as OutreachProspectRow[];
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

/**
 * Drafts a bulk rewrite has not reached yet, oldest first.
 *
 * "Not reached yet" is `updated_at < before`, where `before` is the instant the
 * rewrite run started. Every rewrite stamps `updated_at`, so a draft leaves this
 * window the moment it is done and the next batch reads the next slice. That is
 * why the cursor is a timestamp and not an offset: the set shifts under a bulk
 * pass (a sweep can send one, the owner can skip one), and an offset would step
 * over the rows that moved.
 */
export async function listProspectsToRewrite(
  businessId: string,
  beforeIso: string,
  limit: number,
  client?: SupabaseClient
): Promise<OutreachProspectRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .select()
    .eq("business_id", businessId)
    .eq("status", "drafted")
    .lt("updated_at", beforeIso)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`listProspectsToRewrite: ${error.message}`);
  return (data ?? []) as OutreachProspectRow[];
}

/** How many drafts that same run still has to reach. Drives the progress line. */
export async function countProspectsToRewrite(
  businessId: string,
  beforeIso: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("outreach_prospects")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("status", "drafted")
    .lt("updated_at", beforeIso);
  if (error) throw new Error(`countProspectsToRewrite: ${error.message}`);
  return count ?? 0;
}

/**
 * Statuses a whole trade can still be called off at.
 *
 * `discovered` is a prospect the sweep has not written to yet; `drafted` is one
 * waiting on the owner. Everything later is excluded on purpose: `queued` is
 * already in flight, and a sent pitch is a thing that happened, so retiring the
 * trade must not rewrite the record of mail that is already in somebody's
 * inbox.
 */
const CANCELLABLE_STATUSES: OutreachProspectStatus[] = ["discovered", "drafted"];

/**
 * The funnel is a LABEL, the column is a VALUE, and for one bucket they differ.
 *
 * `summarizeFunnel` groups rows with a blank `vertical` under
 * `UNKNOWN_VERTICAL`, and no row stores that string. Filtering on it literally
 * matches nothing, so the Skip button on that row would report success and
 * retire none of the prospects it was pointing at. That bucket has to become
 * "null or empty" on the way to the database, and both queries below have to
 * translate it the SAME way, which is what this constant is for.
 *
 * Blank means null or the empty string. Whitespace-only cannot occur:
 * `saveProspectingSettings` trims every search term and drops the empty ones,
 * and a prospect's vertical is copied from the term that found it.
 */
const BLANK_VERTICAL_FILTER = "vertical.is.null,vertical.eq.";

/** How many prospects in one trade a skip would still catch. */
export async function countProspectsInVertical(
  businessId: string,
  vertical: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db
    .from("outreach_prospects")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .in("status", CANCELLABLE_STATUSES);
  const { count, error } =
    vertical === UNKNOWN_VERTICAL
      ? await base.or(BLANK_VERTICAL_FILTER)
      : await base.eq("vertical", vertical);
  if (error) throw new Error(`countProspectsInVertical: ${error.message}`);
  return count ?? 0;
}

/**
 * Retire every prospect in one trade that has not gone out yet.
 *
 * The owner stopped looking for this kind of business, so the drafts already
 * queued for it are work nobody wants done. Skipped rather than deleted, for
 * the same reason a single Skip is: the row is what keeps the domain out of
 * future discovery, so deleting it would invite the sweep to find them again.
 *
 * The status filter rides inside the UPDATE rather than being read first, so a
 * prospect the sweep sends between the page load and the press is left alone
 * instead of being marked skipped after the fact.
 */
export async function skipProspectsInVertical(
  businessId: string,
  vertical: string,
  detail: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const base = db
    .from("outreach_prospects")
    .update({ status: "skipped", status_detail: detail, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .in("status", CANCELLABLE_STATUSES);
  const { error } =
    vertical === UNKNOWN_VERTICAL
      ? await base.or(BLANK_VERTICAL_FILTER)
      : await base.eq("vertical", vertical);
  if (error) throw new Error(`skipProspectsInVertical: ${error.message}`);
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
 *
 * Equality, not ILIKE, and that is not a micro-optimization: ILIKE reads `_`
 * as a single-character wildcard, and underscores are ordinary in email local
 * parts, so `john_smith@acme.com` would also match `johnXsmith@acme.com` and
 * could mark the wrong prospect replied. Addresses are written lowercase (the
 * probe lowercases what it scrapes), so equality on a lowercased needle is both
 * exact and an index lookup.
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
    .eq("email", normalized)
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
 *
 * A reply moves the row off `sent`, so the status filter alone would do. The
 * explicit `replied_at is null` is belt and braces on the one thing that must
 * never happen: a machine following up on somebody who already answered.
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
    .is("replied_at", null)
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
    | "pitch_paragraphs"
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
 * in `fromStatus`. Returns whether a row actually moved, which is the claim
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

/**
 * Claim today's discovery pass for a business, atomically.
 *
 * Discovery buys paid Places queries, so "have we already run today?" cannot be
 * a read followed by a write: two overlapping sweeps would both read yesterday's
 * stamp, both decide they are due, and both buy the same searches. The condition
 * rides inside the UPDATE, so the loser matches zero rows and skips.
 *
 * Stamping BEFORE the queries (rather than after) is the same decision in the
 * other direction: at-most-once beats at-least-once when the retry is billable.
 */
export async function claimDiscoveryRun(
  businessId: string,
  nowIso: string,
  dayStartIso: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_settings")
    .update({ last_discovery_at: nowIso, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .or(`last_discovery_at.is.null,last_discovery_at.lt.${dayStartIso}`)
    .select("business_id");
  if (error) throw new Error(`claimDiscoveryRun: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Claim the ONE follow-up a prospect ever gets, atomically.
 *
 * `transitionProspect` guards on status, which is enough for the first pitch
 * (drafted to sent) but not for a nudge: the row stays `sent` either way, so
 * two overlapping passes would both win the status check and both send. The
 * guard that matters here is `nudged_at is null`, evaluated inside the same
 * UPDATE that sets it, so exactly one caller can ever win.
 */
export async function claimProspectNudge(
  businessId: string,
  prospectId: string,
  nowIso: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("outreach_prospects")
    .update({ nudged_at: nowIso, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("id", prospectId)
    .eq("status", "sent")
    .is("nudged_at", null)
    .select("id");
  if (error) throw new Error(`claimProspectNudge: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** Sends already made in the current window: half the daily-cap numerator. */
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
