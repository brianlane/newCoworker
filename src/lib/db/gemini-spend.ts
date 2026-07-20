/**
 * Accessors for the Gemini spend observability tables
 * (migration 20260815010000_gemini_spend_ledger.sql):
 *
 *   - `gemini_spend_daily`  — roll-up VIEW over the append-only
 *     `gemini_spend_events` ledger (one row per metered Gemini call,
 *     written inside the owner_chat_record_spend / owner_chat_ai_settle
 *     RPCs), per UTC day / tenant / surface / model / pricing source.
 *   - `gemini_billed_daily` — Google's ACTUAL billed cost per UTC day +
 *     GCP project, synced from the Cloud Billing BigQuery export
 *     (src/lib/admin/gemini-billed-sync.ts).
 *
 * Everything is service-role only (RLS on, no policies). Nothing bills
 * from these rows — they feed the admin Gemini/Usage pages and the
 * metered-vs-billed reconciliation.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type GeminiSpendDailyRow = {
  day: string; // YYYY-MM-DD (UTC)
  business_id: string;
  surface: string;
  model: string;
  pricing_source: "exact" | "estimate" | "override";
  call_count: number;
  prompt_tokens: number;
  output_tokens: number;
  cost_micros: number;
};

/**
 * All roll-up rows with `day >= sinceDay`, oldest first. Paged in 1000-row
 * chunks — PostgREST silently caps a single request at 1000 rows, which
 * would drop the newest days without any error as history grows.
 */
export async function listGeminiSpendDaily(
  sinceDay: string,
  client?: SupabaseClient
): Promise<GeminiSpendDailyRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const pageSize = 1000;
  const all: GeminiSpendDailyRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("gemini_spend_daily")
      .select()
      .gte("day", sinceDay)
      .order("day", { ascending: true })
      .order("business_id", { ascending: true })
      .order("surface", { ascending: true })
      .order("model", { ascending: true })
      .order("pricing_source", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`listGeminiSpendDaily: ${error.message}`);
    const rows = (data ?? []) as GeminiSpendDailyRow[];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

export type GeminiBilledDailyInsert = {
  day: string; // YYYY-MM-DD (UTC)
  gcp_project_id: string;
  cost_micros: number;
};

export type GeminiBilledDailyRow = GeminiBilledDailyInsert & {
  id: number;
  synced_at: string;
};

/**
 * Idempotent write for a rolling billed-sync window: replace every row with
 * `day >= windowStartDay` with the fresh aggregates, delete+insert inside
 * ONE transaction (`replace_gemini_billed_window` SQL function) so a failed
 * insert can never leave the window deleted-but-empty.
 */
export async function replaceGeminiBilledWindow(
  windowStartDay: string,
  rows: GeminiBilledDailyInsert[],
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.rpc("replace_gemini_billed_window", {
    p_window_start: windowStartDay,
    p_rows: rows
  });
  if (error) throw new Error(`replaceGeminiBilledWindow: ${error.message}`);
}

/**
 * All billed rows with `day >= sinceDay`, oldest first. Paged in 1000-row
 * chunks for the same silent-PostgREST-cap reason as listGeminiSpendDaily.
 */
export async function listGeminiBilledDaily(
  sinceDay: string,
  client?: SupabaseClient
): Promise<GeminiBilledDailyRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const pageSize = 1000;
  const all: GeminiBilledDailyRow[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("gemini_billed_daily")
      .select()
      .gte("day", sinceDay)
      .order("day", { ascending: true })
      .order("gcp_project_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`listGeminiBilledDaily: ${error.message}`);
    const rows = (data ?? []) as GeminiBilledDailyRow[];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

/**
 * Prune ledger events older than the retention window (~200 days; the SQL
 * function floors the arg at 90 so nothing can wipe the admin views).
 * Returns rows removed. Callers treat failures as best-effort.
 */
export async function pruneGeminiSpendEvents(client?: SupabaseClient): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db.rpc("gemini_spend_events_prune", { p_keep_days: 200 });
  if (error) throw new Error(`pruneGeminiSpendEvents: ${error.message}`);
  const n = Number(data ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
