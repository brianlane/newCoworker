/**
 * Lead-source reporting (the FUB accountability story) — derived entirely
 * from signals other features already write, no new stamping:
 *
 *   - CHANNELS: `contacts.last_channel` (sms / voice / messenger /
 *     instagram / webchat …) — where the relationship lives today;
 *   - SOURCE TAGS: `contacts.tags` — the platform's actual source-stamping
 *     mechanism (intake flows tag their leads via update_contact, pipeline
 *     stages are tags, imports carry tags).
 *
 * For each group over the trailing window's NEW customer contacts:
 *   - newContacts — rows created in the window;
 *   - engaged     — of those, how many have interacted at least once;
 *   - claimed     — of those, how many a roster member owns.
 *
 * A contact with neither a channel nor any tag counts as UNTRACKED — that
 * number is the honest residue of intake paths with no source signal
 * (manual adds, bare CSV imports), surfaced rather than hidden so owners
 * know how much of their funnel is dark.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type LeadSourceRow = {
  /** Display label: the channel name or the tag (first-seen casing). */
  label: string;
  newContacts: number;
  engaged: number;
  claimed: number;
};

export type LeadSourceOverview = {
  /** New customer contacts created in the window. */
  totalNewContacts: number;
  /** New contacts with no channel and no tags — no source signal at all. */
  untracked: number;
  /** By last_channel, largest first. */
  channels: LeadSourceRow[];
  /** By tag (a contact counts once per tag it carries), largest first. */
  tags: LeadSourceRow[];
  windowDays: number;
  /** True when the scan filled its cap — counts are partial. */
  clipped: boolean;
};

export const LEAD_SOURCE_WINDOW_DAYS = 30;
/** Tag rows shown (a tenant can carry many one-off tags). */
export const LEAD_SOURCE_TAG_LIMIT = 12;
/** New-contact rows scanned per window — far above current tenant volumes. */
export const LEAD_SOURCE_SCAN_LIMIT = 5000;

export type LeadSourceContact = {
  last_channel: string | null;
  tags: string[] | null;
  owner_employee_id: string | null;
  total_interaction_count: number;
};

/** Pure: fold scanned rows into the channel/tag breakdowns. */
export function buildLeadSourceOverview(
  rows: LeadSourceContact[],
  opts: { windowDays: number; clipped: boolean }
): LeadSourceOverview {
  type Bucket = { label: string; newContacts: number; engaged: number; claimed: number };
  const channels = new Map<string, Bucket>();
  const tags = new Map<string, Bucket>();
  let untracked = 0;

  const bump = (map: Map<string, Bucket>, label: string, row: LeadSourceContact) => {
    const key = label.toLowerCase();
    const bucket = map.get(key) ?? { label, newContacts: 0, engaged: 0, claimed: 0 };
    bucket.newContacts += 1;
    if (row.total_interaction_count > 0) bucket.engaged += 1;
    if (row.owner_employee_id) bucket.claimed += 1;
    map.set(key, bucket);
  };

  for (const row of rows) {
    const channel = (row.last_channel ?? "").trim();
    const rowTags = (Array.isArray(row.tags) ? row.tags : [])
      .map((t) => t.trim())
      .filter(Boolean);
    if (channel) bump(channels, channel, row);
    for (const tag of rowTags) bump(tags, tag, row);
    if (!channel && rowTags.length === 0) untracked += 1;
  }

  const byVolume = (a: Bucket, b: Bucket) =>
    b.newContacts - a.newContacts || a.label.localeCompare(b.label);
  return {
    totalNewContacts: rows.length,
    untracked,
    channels: [...channels.values()].sort(byVolume),
    tags: [...tags.values()].sort(byVolume).slice(0, LEAD_SOURCE_TAG_LIMIT),
    windowDays: opts.windowDays,
    clipped: opts.clipped
  };
}

/**
 * The window's new CUSTOMER contacts (owner/employee/company rows are
 * directory entries, not lead intake), folded into the source breakdowns.
 */
export async function getLeadSourceOverview(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date; windowDays?: number } = {}
): Promise<LeadSourceOverview> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? LEAD_SOURCE_WINDOW_DAYS;
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("contacts")
    .select("last_channel, tags, owner_employee_id, total_interaction_count")
    .eq("business_id", businessId)
    .eq("type", "customer")
    .gte("created_at", since)
    .limit(LEAD_SOURCE_SCAN_LIMIT);
  if (error) throw new Error(`getLeadSourceOverview: ${error.message}`);

  const rows = ((data as LeadSourceContact[] | null) ?? []);
  return buildLeadSourceOverview(rows, {
    windowDays,
    clipped: rows.length >= LEAD_SOURCE_SCAN_LIMIT
  });
}
