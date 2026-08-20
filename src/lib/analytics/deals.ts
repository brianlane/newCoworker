/**
 * Deals reporting (owner-only card): what the funnel is worth.
 *
 * Two horizons on one card, because they answer different questions:
 *   - the trailing 30-day WINDOW: deals created, deals won (by `won_at`, a
 *     deal created months ago that closed this week is this window's win)
 *     with their value;
 *   - the ALL-TIME OPEN BOOK: every open / under-contract deal regardless
 *     of age, the pipeline an owner is still working.
 *
 * Window wins are broken down two ways, both joined through the deal's
 * contact reference:
 *   - by `contacts.lead_source` (which source actually turns into money,
 *     not just into contacts, the missing half of the lead-sources card);
 *   - by `contacts.owner_employee_id` (which teammate closes, resolved to
 *     roster names; unowned and contactless deals stay visible as their own
 *     rows rather than vanishing).
 *
 * Values are summed in integer cents. v1 sums across the tenant's single
 * currency (deals default to USD); a mixed-currency book would need
 * per-currency buckets before these totals mean anything.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { analyticsWindowStart } from "@/lib/analytics/dashboard-analytics";
import { listTeamMembers } from "@/lib/db/employees";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const DEALS_ANALYTICS_WINDOW_DAYS = 30;
/** Rows scanned per query, far above current per-tenant deal volumes. */
export const DEALS_ANALYTICS_SCAN_LIMIT = 2000;
/** Contact ids per .in() chunk, keeps the PostgREST GET URL well-formed. */
export const DEALS_CONTACT_CHUNK = 150;

export type WonDealRow = {
  contact_id: string | null;
  value_cents: number | null;
};

export type OpenDealRow = {
  value_cents: number | null;
};

export type DealContactFacts = {
  id: string;
  lead_source: string | null;
  owner_employee_id: string | null;
};

export type DealsSourceRow = {
  /** lead_source (first-seen casing), or the no-source/no-contact bucket. */
  label: string;
  wonCount: number;
  wonValueCents: number;
};

export type DealsOwnerRow = {
  /** Roster member id; null = the deal's contact is unowned or missing. */
  employeeId: string | null;
  name: string;
  wonCount: number;
  wonValueCents: number;
};

export type DealsOverview = {
  windowDays: number;
  /** Deals created in the window. */
  createdCount: number;
  /** Deals won in the window (by won_at), and what they were worth. */
  wonCount: number;
  wonValueCents: number;
  /** All-time open book: open + under_contract deals, any age. */
  openCount: number;
  openValueCents: number;
  bySource: DealsSourceRow[];
  byOwner: DealsOwnerRow[];
  /** True when any scan filled its cap, counts are partial. */
  clipped: boolean;
};

/** The label for won deals whose contact has no lead_source (or no contact). */
export const DEALS_NO_SOURCE_LABEL = "No source";
/** The label for won deals whose contact is unowned (or missing). */
export const DEALS_UNASSIGNED_LABEL = "Unassigned";

/** Pure: fold the scanned rows into the overview shape. */
export function buildDealsOverview(input: {
  createdCount: number;
  wonDeals: WonDealRow[];
  openDeals: OpenDealRow[];
  contacts: DealContactFacts[];
  members: { id: string; name: string }[];
  windowDays: number;
  clipped: boolean;
}): DealsOverview {
  const contactById = new Map(input.contacts.map((c) => [c.id, c]));
  const memberName = new Map(input.members.map((m) => [m.id, m.name]));

  type SourceBucket = { label: string; wonCount: number; wonValueCents: number };
  const sources = new Map<string, SourceBucket>();
  type OwnerBucket = {
    employeeId: string | null;
    name: string;
    wonCount: number;
    wonValueCents: number;
  };
  const owners = new Map<string, OwnerBucket>();

  let wonValueCents = 0;
  for (const deal of input.wonDeals) {
    const value = deal.value_cents ?? 0;
    wonValueCents += value;
    const contact = deal.contact_id ? contactById.get(deal.contact_id) ?? null : null;

    // Case-insensitive fold under the first-seen casing, same as the
    // lead-sources card, so "Zillow" and "zillow" are one row of money.
    const sourceLabel = contact?.lead_source?.trim() || DEALS_NO_SOURCE_LABEL;
    const sourceKey = sourceLabel.toLowerCase();
    const sourceBucket =
      sources.get(sourceKey) ?? { label: sourceLabel, wonCount: 0, wonValueCents: 0 };
    sourceBucket.wonCount += 1;
    sourceBucket.wonValueCents += value;
    sources.set(sourceKey, sourceBucket);

    const employeeId = contact?.owner_employee_id ?? null;
    const ownerKey = employeeId ?? "unassigned";
    const ownerBucket = owners.get(ownerKey) ?? {
      employeeId,
      // A removed roster row still closed the deal; keep it visible.
      name: employeeId
        ? memberName.get(employeeId) ?? "Former teammate"
        : DEALS_UNASSIGNED_LABEL,
      wonCount: 0,
      wonValueCents: 0
    };
    ownerBucket.wonCount += 1;
    ownerBucket.wonValueCents += value;
    owners.set(ownerKey, ownerBucket);
  }

  let openValueCents = 0;
  for (const deal of input.openDeals) openValueCents += deal.value_cents ?? 0;

  const byMoney = <T extends { wonValueCents: number; wonCount: number; label?: string }>(
    a: T,
    b: T
  ) => b.wonValueCents - a.wonValueCents || b.wonCount - a.wonCount;

  return {
    windowDays: input.windowDays,
    createdCount: input.createdCount,
    wonCount: input.wonDeals.length,
    wonValueCents,
    openCount: input.openDeals.length,
    openValueCents,
    bySource: [...sources.values()].sort(byMoney),
    byOwner: [...owners.values()].sort(byMoney),
    clipped: input.clipped
  };
}

/**
 * Scan the deals book and fold it into the overview. Window start is UTC
 * day-aligned via analyticsWindowStart, matching every other card on the
 * page, so "30 days" means the same instant everywhere.
 */
export async function getDealsOverview(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date; windowDays?: number } = {}
): Promise<DealsOverview> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? DEALS_ANALYTICS_WINDOW_DAYS;
  const since = analyticsWindowStart(now, windowDays).toISOString();

  const [createdRes, wonRes, openRes, members] = await Promise.all([
    db
      .from("deals")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .gte("created_at", since),
    db
      .from("deals")
      .select("contact_id, value_cents")
      .eq("business_id", businessId)
      .eq("status", "won")
      .gte("won_at", since)
      .order("won_at", { ascending: false })
      .limit(DEALS_ANALYTICS_SCAN_LIMIT),
    db
      .from("deals")
      .select("value_cents")
      .eq("business_id", businessId)
      .in("status", ["open", "under_contract"])
      .order("created_at", { ascending: false })
      .limit(DEALS_ANALYTICS_SCAN_LIMIT),
    listTeamMembers(businessId, db)
  ]);
  if (createdRes.error) {
    throw new Error(`getDealsOverview: created: ${createdRes.error.message}`);
  }
  if (wonRes.error) throw new Error(`getDealsOverview: won: ${wonRes.error.message}`);
  if (openRes.error) throw new Error(`getDealsOverview: open: ${openRes.error.message}`);

  const wonDeals = ((wonRes.data as WonDealRow[] | null) ?? []);
  const openDeals = ((openRes.data as OpenDealRow[] | null) ?? []);

  const contactIds = [
    ...new Set(wonDeals.map((d) => d.contact_id).filter((id): id is string => !!id))
  ];
  const contacts: DealContactFacts[] = [];
  for (let i = 0; i < contactIds.length; i += DEALS_CONTACT_CHUNK) {
    const chunk = contactIds.slice(i, i + DEALS_CONTACT_CHUNK);
    const { data, error } = await db
      .from("contacts")
      .select("id, lead_source, owner_employee_id")
      .eq("business_id", businessId)
      .in("id", chunk);
    if (error) throw new Error(`getDealsOverview: contacts: ${error.message}`);
    contacts.push(...(((data as DealContactFacts[] | null) ?? [])));
  }

  return buildDealsOverview({
    createdCount: createdRes.count ?? 0,
    wonDeals,
    openDeals,
    contacts,
    members,
    windowDays,
    clipped:
      wonDeals.length >= DEALS_ANALYTICS_SCAN_LIMIT ||
      openDeals.length >= DEALS_ANALYTICS_SCAN_LIMIT
  });
}
