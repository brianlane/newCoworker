/**
 * Duplicate-contact detection with completeness-scored merge direction —
 * concept ported from BizBlasts' CustomerLinker (`customer_completeness_score`
 * / `select_canonical_customer`).
 *
 * newCoworker keys contacts by phone number, so the duplicate class here is
 * "one person, two numbers": rows sharing the SAME EMAIL are (almost always)
 * the same human reached on two lines. Nothing is merged automatically —
 * `findDuplicateContactPairs` surfaces suggestions on the Contacts page and
 * recommends a direction (the more complete profile survives), and the
 * owner confirms through the existing merge endpoint. The one automatic
 * consumer is the CSV importer's email cross-fold (src/lib/csv/contacts.ts),
 * which uses the same identity signal with a strict single-match guard.
 *
 * Service-role only, same trust model as customer-memory/db.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** The slice of a contacts row the scorer consumes. */
export type ScorableContact = {
  customer_e164: string;
  display_name: string | null;
  name_source?: string | null;
  email: string | null;
  summary_md: string | null;
  pinned_md: string | null;
  tags?: string[] | null;
  birthday?: string | null;
  total_interaction_count: number;
  last_interaction_at: string | null;
  created_at: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Data-completeness score (higher = better merge survivor), ported from
 * BizBlasts' `customer_completeness_score`: identity fields and owner-authored
 * content weigh most, then relationship depth (interactions) and recency.
 */
export function contactCompletenessScore(
  contact: ScorableContact,
  now: Date = new Date()
): number {
  let score = 0;
  if ((contact.display_name ?? "").trim()) {
    score += 2;
    // An owner-typed name is a deliberate label — worth more than an
    // auto-captured one.
    if (contact.name_source === "manual") score += 1;
  }
  if ((contact.email ?? "").trim()) score += 2;
  if ((contact.summary_md ?? "").trim()) score += 2;
  if ((contact.pinned_md ?? "").trim()) score += 2;
  if ((contact.tags ?? []).length > 0) score += 1;
  if (contact.birthday) score += 1;
  // Relationship depth, capped so a chatty duplicate can't outweigh every
  // identity field combined.
  score += Math.min(contact.total_interaction_count, 50) / 10;
  const last = contact.last_interaction_at ? Date.parse(contact.last_interaction_at) : NaN;
  if (Number.isFinite(last)) {
    const age = now.getTime() - last;
    if (age <= 90 * DAY_MS) score += 2;
    else if (age <= 365 * DAY_MS) score += 1;
  }
  return score;
}

/**
 * Recommended merge direction for a duplicate pair: the more complete
 * profile survives (`into`); ties break to more interactions, then to the
 * older row (its number has been the person's contact point longer).
 */
export function pickCanonicalContact<T extends ScorableContact>(
  a: T,
  b: T,
  now: Date = new Date()
): { into: T; from: T } {
  const scoreA = contactCompletenessScore(a, now);
  const scoreB = contactCompletenessScore(b, now);
  if (scoreA !== scoreB) {
    return scoreA > scoreB ? { into: a, from: b } : { into: b, from: a };
  }
  if (a.total_interaction_count !== b.total_interaction_count) {
    return a.total_interaction_count > b.total_interaction_count
      ? { into: a, from: b }
      : { into: b, from: a };
  }
  return Date.parse(a.created_at) <= Date.parse(b.created_at)
    ? { into: a, from: b }
    : { into: b, from: a };
}

export type DuplicateContactPair = {
  /** Shared (lowercased) email that links the pair. */
  email: string;
  /** Recommended survivor. */
  intoE164: string;
  intoName: string | null;
  /** Recommended fold-away row. */
  fromE164: string;
  fromName: string | null;
};

/** Cap on suggestions per page load — a directory-wide audit is not the goal. */
export const MAX_DUPLICATE_PAIRS = 10;

const SCAN_COLUMNS =
  "customer_e164,display_name,name_source,email,summary_md,pinned_md,tags," +
  "birthday,total_interaction_count,last_interaction_at,created_at";

type ScanRow = ScorableContact & { email: string };

/**
 * Customer profiles that share an email address, paired with a recommended
 * merge direction. Only `type = 'customer'` rows are considered — the merge
 * endpoint refuses every other contact type. Groups larger than two produce
 * one pair per non-canonical row (all folding into the same survivor).
 */
export async function findDuplicateContactPairs(
  businessId: string,
  opts: { client?: SupabaseClient; now?: Date } = {}
): Promise<DuplicateContactPair[]> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  const now = opts.now ?? new Date();
  const { data, error } = await db
    .from("contacts")
    .select(SCAN_COLUMNS)
    .eq("business_id", businessId)
    .eq("type", "customer")
    .not("email", "is", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`findDuplicateContactPairs: ${error.message}`);

  const byEmail = new Map<string, ScanRow[]>();
  for (const raw of (data ?? []) as unknown as ScanRow[]) {
    const email = (raw.email ?? "").trim().toLowerCase();
    if (!email) continue;
    const group = byEmail.get(email);
    if (group) group.push(raw);
    else byEmail.set(email, [raw]);
  }

  const pairs: DuplicateContactPair[] = [];
  for (const [email, group] of byEmail) {
    if (group.length < 2) continue;
    // One survivor per group: score every row, keep the best.
    let canonical = group[0];
    for (const candidate of group.slice(1)) {
      canonical = pickCanonicalContact(canonical, candidate, now).into;
    }
    for (const row of group) {
      if (row.customer_e164 === canonical.customer_e164) continue;
      pairs.push({
        email,
        intoE164: canonical.customer_e164,
        intoName: canonical.display_name,
        fromE164: row.customer_e164,
        fromName: row.display_name
      });
      if (pairs.length >= MAX_DUPLICATE_PAIRS) return pairs;
    }
  }
  return pairs;
}
