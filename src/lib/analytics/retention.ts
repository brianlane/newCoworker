/**
 * Customer retention report — who keeps coming back, who slipped away.
 *
 * Built on the same recency bands as the engagement segments
 * (src/lib/analytics/engagement.ts) but answering the RETENTION question:
 * of the customers the business has actually talked to, how many are still
 * engaged, how many are returning relationships (older than the window yet
 * active inside it), and how many lapsed. Derived entirely from `contacts`
 * recency columns — no per-interaction history needed, so it works even
 * after retention pruning ages raw messages out.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  ENGAGEMENT_ACTIVE_DAYS,
  ENGAGEMENT_COOLING_DAYS,
  ENGAGEMENT_SCAN_LIMIT,
  classifyEngagement
} from "./engagement";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type RetentionOverview = {
  /** Customers with at least one recorded interaction, ever. */
  engagedEver: number;
  /** Interacted within the active window (30 days). */
  retained: number;
  /** 30–90 days silent — the at-risk middle. */
  atRisk: number;
  /** 90+ days silent — lapsed relationships. */
  lapsed: number;
  /** retained / engagedEver, 0-1; null when nobody has interacted yet. */
  retentionRate: number | null;
  /** Active in the window AND first seen before it — returning relationships. */
  returning: number;
  /** Contacts created within the window (new relationships forming). */
  newInWindow: number;
  /** True when the directory scan filled its cap — counts are partial. */
  clipped: boolean;
};

export async function getRetentionOverview(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date } = {}
): Promise<RetentionOverview> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const windowMs = ENGAGEMENT_ACTIVE_DAYS * 24 * 60 * 60 * 1000;

  const { data, error } = await db
    .from("contacts")
    .select("created_at, last_interaction_at, total_interaction_count")
    .eq("business_id", businessId)
    .eq("type", "customer")
    .limit(ENGAGEMENT_SCAN_LIMIT);
  if (error) throw new Error(`getRetentionOverview: ${error.message}`);

  type Row = {
    created_at: string;
    last_interaction_at: string | null;
    total_interaction_count: number;
  };
  const rows = ((data as Row[] | null) ?? []);

  let engagedEver = 0;
  let retained = 0;
  let atRisk = 0;
  let lapsed = 0;
  let returning = 0;
  let newInWindow = 0;
  for (const row of rows) {
    const created = Date.parse(row.created_at);
    if (Number.isFinite(created) && now.getTime() - created <= windowMs) {
      newInWindow += 1;
    }
    const interacted = row.last_interaction_at !== null || row.total_interaction_count > 0;
    if (!interacted) continue;
    engagedEver += 1;
    const segment = classifyEngagement(row, now);
    if (segment === "active" || segment === "new") {
      retained += 1;
      if (Number.isFinite(created) && now.getTime() - created > windowMs) {
        returning += 1;
      }
    } else if (segment === "cooling") {
      atRisk += 1;
    } else {
      lapsed += 1;
    }
  }

  return {
    engagedEver,
    retained,
    atRisk,
    lapsed,
    retentionRate: engagedEver > 0 ? Math.round((retained / engagedEver) * 100) / 100 : null,
    returning,
    newInWindow,
    clipped: rows.length >= ENGAGEMENT_SCAN_LIMIT
  };
}

export { ENGAGEMENT_ACTIVE_DAYS, ENGAGEMENT_COOLING_DAYS };
