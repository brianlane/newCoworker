/**
 * Quote funnel report — quote lifecycle tracking over the canonical stage
 * TAGS. Stages ride the existing contact-tag machinery on purpose: the
 * pipeline board renders them as columns, the Contacts page filters on
 * them, tag edits fire the normal tag_changed automation hooks (so an
 * AiFlow can advance a stage with update_contact), and CSV import can bulk
 * load them — no new table, no new writers.
 *
 * A contact counts once, at its FURTHEST stage (someone tagged both
 * requested and won is a win, not two funnel entries). `quote-lost` is the
 * terminal drop-out. Conversion = won / everyone who ever entered the
 * funnel.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { ENGAGEMENT_SCAN_LIMIT } from "./engagement";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Funnel order, mildest → terminal-won. `quote-lost` sits outside the ladder. */
export const QUOTE_STAGE_TAGS = [
  "quote-requested",
  "quote-received",
  "quote-presented",
  "quote-won"
] as const;

export const QUOTE_LOST_TAG = "quote-lost";

export type QuoteStage = (typeof QUOTE_STAGE_TAGS)[number] | typeof QUOTE_LOST_TAG;

export const QUOTE_STAGE_LABELS: Record<QuoteStage, string> = {
  "quote-requested": "Requested",
  "quote-received": "Received",
  "quote-presented": "Presented",
  "quote-won": "Won",
  "quote-lost": "Lost"
};

/**
 * The contact's single funnel bucket from its tags: `quote-lost` is
 * terminal and wins over everything; otherwise the furthest ladder stage.
 * Null when the contact carries no quote-stage tag at all.
 */
export function quoteStageForTags(tags: readonly string[]): QuoteStage | null {
  const normalized = new Set(tags.map((t) => t.trim().toLowerCase()));
  if (normalized.has(QUOTE_LOST_TAG)) return QUOTE_LOST_TAG;
  for (let i = QUOTE_STAGE_TAGS.length - 1; i >= 0; i -= 1) {
    if (normalized.has(QUOTE_STAGE_TAGS[i])) return QUOTE_STAGE_TAGS[i];
  }
  return null;
}

export type QuoteFunnel = {
  /** Contacts per bucket (each contact counted once, at its furthest stage). */
  counts: Record<QuoteStage, number>;
  /** Contacts carrying any quote-stage tag. */
  totalTracked: number;
  /** won / totalTracked, 0-1; null when nothing is tracked yet. */
  conversionRate: number | null;
  /** True when the directory scan filled its cap — counts are partial. */
  clipped: boolean;
};

export async function getQuoteFunnel(
  businessId: string,
  opts: { client?: SupabaseClient } = {}
): Promise<QuoteFunnel> {
  const db = opts.client ?? (await createSupabaseServiceClient());
  // Full customer-directory scan (same cap as the engagement segments):
  // stage matching is case-insensitive and tag normalization preserves the
  // owner's original casing, so a case-sensitive SQL tag filter would
  // silently under-count (a contact tagged "Quote-Won" must still count).
  const { data, error } = await db
    .from("contacts")
    .select("tags")
    .eq("business_id", businessId)
    .eq("type", "customer")
    .limit(ENGAGEMENT_SCAN_LIMIT);
  if (error) throw new Error(`getQuoteFunnel: ${error.message}`);

  const rows = ((data as Array<{ tags: string[] | null }> | null) ?? []);
  const counts: Record<QuoteStage, number> = {
    "quote-requested": 0,
    "quote-received": 0,
    "quote-presented": 0,
    "quote-won": 0,
    "quote-lost": 0
  };
  let totalTracked = 0;
  for (const row of rows) {
    const stage = quoteStageForTags(row.tags ?? []);
    if (!stage) continue;
    counts[stage] += 1;
    totalTracked += 1;
  }

  return {
    counts,
    totalTracked,
    conversionRate:
      totalTracked > 0 ? Math.round((counts["quote-won"] / totalTracked) * 100) / 100 : null,
    clipped: rows.length >= ENGAGEMENT_SCAN_LIMIT
  };
}
