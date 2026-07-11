/**
 * Contact engagement segments + "quiet customers" detection — BizBlasts'
 * RFM segmentation / ChurnPredictionService ported to engagement terms
 * (newCoworker holds no tenant revenue, so interaction recency/frequency
 * stands in for purchase recency/monetary value).
 *
 * Segments (recency bands over `contacts.last_interaction_at`):
 *   - active  — talked to the business in the last 30 days
 *   - cooling — 30–90 days silent
 *   - new     — never interacted (or nothing recent) but added < 30 days ago
 *   - quiet   — 90+ days silent (or never, and not new): the at-risk list
 *
 * The quiet list is the actionable output — the owner's natural target for
 * a win-back flow — ordered by lifetime interactions so the most valuable
 * lapsed customers surface first.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type EngagementSegment = "new" | "active" | "cooling" | "quiet";

export const ENGAGEMENT_ACTIVE_DAYS = 30;
export const ENGAGEMENT_COOLING_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export type EngagementContact = {
  created_at: string;
  last_interaction_at: string | null;
};

/** Recency-band classification (see module doc for the bands). */
export function classifyEngagement(
  contact: EngagementContact,
  now: Date = new Date()
): EngagementSegment {
  const last = contact.last_interaction_at ? Date.parse(contact.last_interaction_at) : NaN;
  if (Number.isFinite(last)) {
    const age = now.getTime() - last;
    if (age <= ENGAGEMENT_ACTIVE_DAYS * DAY_MS) return "active";
    if (age <= ENGAGEMENT_COOLING_DAYS * DAY_MS) return "cooling";
  }
  const created = Date.parse(contact.created_at);
  if (Number.isFinite(created) && now.getTime() - created <= ENGAGEMENT_ACTIVE_DAYS * DAY_MS) {
    return "new";
  }
  return "quiet";
}

export type QuietCustomer = {
  e164: string;
  name: string | null;
  lastInteractionAt: string | null;
  totalInteractions: number;
};

export type EngagementOverview = {
  counts: Record<EngagementSegment, number>;
  total: number;
  /** Most-engaged-ever quiet customers first — the win-back shortlist. */
  quietCustomers: QuietCustomer[];
};

/** Quiet-list display cap. */
export const QUIET_CUSTOMER_LIMIT = 8;

/** Contacts scanned per overview — far above any current tenant's directory. */
export const ENGAGEMENT_SCAN_LIMIT = 5000;

/**
 * Segment counts + the quiet shortlist for the business's CUSTOMER contacts
 * (owner/employee/company rows are directory entries, not a relationship to
 * nurture).
 */
export async function getEngagementOverview(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date } = {}
): Promise<EngagementOverview> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const { data, error } = await db
    .from("contacts")
    .select("customer_e164, display_name, created_at, last_interaction_at, total_interaction_count")
    .eq("business_id", businessId)
    .eq("type", "customer")
    .limit(ENGAGEMENT_SCAN_LIMIT);
  if (error) throw new Error(`getEngagementOverview: ${error.message}`);

  type Row = {
    customer_e164: string;
    display_name: string | null;
    created_at: string;
    last_interaction_at: string | null;
    total_interaction_count: number;
  };
  const rows = ((data as Row[] | null) ?? []);

  const counts: Record<EngagementSegment, number> = { new: 0, active: 0, cooling: 0, quiet: 0 };
  const quiet: QuietCustomer[] = [];
  for (const row of rows) {
    const segment = classifyEngagement(row, now);
    counts[segment] += 1;
    if (segment === "quiet") {
      quiet.push({
        e164: row.customer_e164,
        name: row.display_name,
        lastInteractionAt: row.last_interaction_at,
        totalInteractions: row.total_interaction_count
      });
    }
  }
  quiet.sort((a, b) => b.totalInteractions - a.totalInteractions);
  return {
    counts,
    total: rows.length,
    quietCustomers: quiet.slice(0, QUIET_CUSTOMER_LIMIT)
  };
}
