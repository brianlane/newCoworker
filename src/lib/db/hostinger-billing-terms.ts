/**
 * Persisted Hostinger term facts, one row per billing subscription.
 *
 * Exists because `hostinger_vps_costs` is full-replaced on every sync, so the
 * previous billing date (the only thing a term change is legible from) does
 * not survive. See src/lib/vps/term-inference.ts for why the span since
 * purchase cannot be used instead.
 *
 * Service-role only, the table has RLS on with no policies.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type HostingerBillingTermRow = {
  subscription_id: string;
  /** Billing date as of the last sync, the baseline a jump is measured from. */
  observed_next_billing_at: string | null;
  /** Inferred length of the current paid term in months; null while unknown. */
  term_months: number | null;
  /** Catalog renewal price for that term divided by its months; null while unknown. */
  monthly_cents: number | null;
  /** 'jump' (measured between syncs) or 'runway_match' (one-time bootstrap). */
  source: "jump" | "runway_match" | null;
  inferred_at: string | null;
  updated_at: string;
};

export type HostingerBillingTermUpsert = {
  subscription_id: string;
  observed_next_billing_at: string | null;
  term_months: number | null;
  monthly_cents: number | null;
  source: "jump" | "runway_match" | null;
  inferred_at: string | null;
};

/** Every stored term row. Small by construction: one per VPS subscription. */
export async function listHostingerBillingTerms(
  client?: SupabaseClient
): Promise<HostingerBillingTermRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.from("hostinger_billing_terms").select();
  if (error) throw new Error(`listHostingerBillingTerms: ${error.message}`);
  return (data ?? []) as HostingerBillingTermRow[];
}

/**
 * Write the given term rows, replacing any existing row for the same
 * subscription.
 *
 * An upsert rather than a full replace: unlike the cost snapshot, these rows
 * carry inference that CANNOT be recomputed from a later sync (a jump is
 * visible exactly once, between the two syncs that straddle it). Deleting and
 * re-inserting would throw that away the first time Hostinger's listing
 * hiccuped and returned a short list.
 */
export async function upsertHostingerBillingTerms(
  rows: HostingerBillingTermUpsert[],
  client?: SupabaseClient
): Promise<void> {
  if (rows.length === 0) return;
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("hostinger_billing_terms")
    .upsert(
      rows.map((row) => ({ ...row, updated_at: new Date().toISOString() })),
      { onConflict: "subscription_id" }
    );
  if (error) throw new Error(`upsertHostingerBillingTerms: ${error.message}`);
}
