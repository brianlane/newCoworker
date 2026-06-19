/**
 * Public AiFlow library persistence (service-role side).
 *
 * Reads the cross-tenant catalog for the browse UI, records downloads when a
 * user duplicates an entry, and provides the upsert + candidate-aggregation
 * primitives the hourly refresh job uses. All writes go through the service
 * role; the catalog table is RLS select-only for users.
 *
 * Schema: supabase/migrations/20260630000000_ai_flow_library.sql.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

async function resolveDb(client?: SupabaseClient): Promise<SupabaseClient> {
  return client ?? (await createSupabaseServiceClient());
}

export type AiFlowLibraryRow = {
  id: string;
  template_key: string;
  title: string;
  summary: string;
  category: string | null;
  scrubbed_definition: AiFlowDefinition;
  total_successful_runs: number;
  total_runs: number;
  businesses_using: number;
  runs_last_7d: number;
  download_count: number;
  last_run_at: string | null;
  stats: Record<string, unknown>;
  first_published_at: string;
  updated_at: string;
};

/** One row per flow with >=1 successful run, from the aggregation RPC. */
export type AiFlowLibraryCandidate = {
  flow_id: string;
  business_id: string;
  name: string;
  definition: AiFlowDefinition;
  business_type: string | null;
  done_count: number;
  total_count: number;
  done_last_7d: number;
  last_done_at: string | null;
};

const LIBRARY_COLS =
  "id,template_key,title,summary,category,scrubbed_definition,total_successful_runs,total_runs,businesses_using,runs_last_7d,download_count,last_run_at,stats,first_published_at,updated_at";

export async function listAiFlowLibrary(
  options: { category?: string } = {},
  client?: SupabaseClient
): Promise<AiFlowLibraryRow[]> {
  const db = await resolveDb(client);
  let query = db.from("ai_flow_library").select(LIBRARY_COLS);
  if (options.category) query = query.eq("category", options.category);
  const { data, error } = await query.order("total_successful_runs", { ascending: false });
  if (error) throw new Error(`listAiFlowLibrary: ${error.message}`);
  return (data ?? []) as AiFlowLibraryRow[];
}

export async function getAiFlowLibraryEntry(
  idOrKey: string,
  client?: SupabaseClient
): Promise<AiFlowLibraryRow | null> {
  const db = await resolveDb(client);
  // The detail page routes by template_key; the duplicate route uses the id.
  // A uuid matches `id`, anything else is treated as a template_key.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrKey);
  const { data, error } = await db
    .from("ai_flow_library")
    .select(LIBRARY_COLS)
    .eq(isUuid ? "id" : "template_key", idOrKey)
    .maybeSingle();
  if (error) throw new Error(`getAiFlowLibraryEntry: ${error.message}`);
  return (data as AiFlowLibraryRow | null) ?? null;
}

/**
 * Record a duplication of a library entry into a business: log the download,
 * then set download_count to the authoritative COUNT of download rows for the
 * entry. Counting the just-written source-of-truth table (rather than bumping a
 * cached value) avoids the lost-update race two concurrent "Use this flow"
 * requests would hit with a read-modify-write. Best-effort — never blocks the
 * duplicate itself.
 */
export async function recordLibraryDownload(
  libraryId: string,
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveDb(client);
  await db.from("ai_flow_library_downloads").insert({ library_id: libraryId, business_id: businessId });
  const { count } = await db
    .from("ai_flow_library_downloads")
    .select("*", { count: "exact", head: true })
    .eq("library_id", libraryId);
  await db
    .from("ai_flow_library")
    .update({ download_count: count ?? 0 })
    .eq("id", libraryId);
}

/**
 * Delete catalog entries whose template_key is NOT in `keepKeys` — i.e. flows
 * that no longer have any successful run. Keeps the public library from showing
 * retired automations with stale stats. When `keepKeys` is empty the whole
 * catalog is cleared (no flow qualifies). Cascades to download rows via FK.
 */
export async function pruneLibraryEntries(
  keepKeys: string[],
  client?: SupabaseClient
): Promise<number> {
  const db = await resolveDb(client);
  const { data, error } = await db.from("ai_flow_library").select("id,template_key");
  if (error) throw new Error(`pruneLibraryEntries: ${error.message}`);
  const keep = new Set(keepKeys);
  const staleIds = (data ?? [])
    .filter((r) => !keep.has(r.template_key as string))
    .map((r) => r.id as string);
  if (staleIds.length === 0) return 0;
  const { error: delError } = await db.from("ai_flow_library").delete().in("id", staleIds);
  if (delError) throw new Error(`pruneLibraryEntries: ${delError.message}`);
  return staleIds.length;
}

/** Run the aggregation RPC: every flow with >=1 successful run + its stats. */
export async function aggregateLibraryCandidates(
  client?: SupabaseClient
): Promise<AiFlowLibraryCandidate[]> {
  const db = await resolveDb(client);
  const { data, error } = await db.rpc("aggregate_ai_flow_library_candidates");
  if (error) throw new Error(`aggregateLibraryCandidates: ${error.message}`);
  return (data ?? []) as AiFlowLibraryCandidate[];
}

export type UpsertLibraryEntryInput = {
  templateKey: string;
  title: string;
  summary: string;
  category: string | null;
  scrubbedDefinition: Record<string, unknown>;
  totalSuccessfulRuns: number;
  totalRuns: number;
  businessesUsing: number;
  runsLast7d: number;
  lastRunAt: string | null;
  stats?: Record<string, unknown>;
};

/**
 * Upsert a library entry by template_key (idempotent refresh). Deliberately
 * does NOT write download_count or first_published_at: download_count is a live
 * counter owned by recordLibraryDownload (omitting it preserves it on update and
 * defaults it to 0 on insert), and first_published_at is preserved on update /
 * defaulted to now() on insert.
 */
export async function upsertLibraryEntry(
  input: UpsertLibraryEntryInput,
  client?: SupabaseClient
): Promise<void> {
  const db = await resolveDb(client);
  const { error } = await db.from("ai_flow_library").upsert(
    {
      template_key: input.templateKey,
      title: input.title,
      summary: input.summary,
      category: input.category,
      scrubbed_definition: input.scrubbedDefinition,
      total_successful_runs: input.totalSuccessfulRuns,
      total_runs: input.totalRuns,
      businesses_using: input.businessesUsing,
      runs_last_7d: input.runsLast7d,
      last_run_at: input.lastRunAt,
      stats: input.stats ?? {}
    },
    { onConflict: "template_key" }
  );
  if (error) throw new Error(`upsertLibraryEntry: ${error.message}`);
}
