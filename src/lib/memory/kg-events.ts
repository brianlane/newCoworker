/**
 * Durable knowledge-graph retrieval ledger (kg_retrieval_events).
 *
 * One row per knowledge lookup on a shadow/active tenant, recording the
 * graph-vs-ranked-memory side-by-side that previously lived only in
 * ephemeral Vercel stdout logs. Powers the /admin/memory-graph comparison
 * view: verdict buckets, stat tiles, and the per-event side-by-side
 * drill-down. Content-bearing (question/answer/context text), so the table
 * joins the end-user erasure surface (src/lib/privacy/deletion.ts) and the
 * daily retention sweep prunes it at a fixed 90 days.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Fixed platform retention for ledger rows (not tenant-configurable). */
export const KG_EVENTS_RETENTION_DAYS = 90;

export type KgRetrievalEventInsert = {
  business_id: string;
  mode: "shadow" | "active";
  question: string;
  answer: string;
  graph_context: string;
  memory_context: string;
  graph_matched_entities: number;
  graph_facts: number;
  graph_context_chars: number;
  memory_context_chars: number;
  memory_selected: number;
  memory_from_archive: number;
  memory_fallback: boolean;
  caller_provided: boolean;
};

export type KgRetrievalEventRow = KgRetrievalEventInsert & {
  id: string;
  created_at: string;
};

export async function recordKgRetrievalEvent(
  event: KgRetrievalEventInsert,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("kg_retrieval_events").insert(event);
  if (error) throw new Error(`recordKgRetrievalEvent: ${error.message}`);
}

/** Newest-first events for one business since `sinceIso` (bounded). */
export async function listKgRetrievalEvents(
  businessId: string,
  sinceIso: string,
  limit = 200,
  client?: SupabaseClient
): Promise<KgRetrievalEventRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("kg_retrieval_events")
    .select()
    .eq("business_id", businessId)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listKgRetrievalEvents: ${error.message}`);
  return (data ?? []) as KgRetrievalEventRow[];
}

/** Exact event count for one business in a window (truncation labels). */
export async function countKgRetrievalEvents(
  businessId: string,
  sinceIso: string,
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const { count, error } = await db
    .from("kg_retrieval_events")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .gte("created_at", sinceIso);
  if (error) throw new Error(`countKgRetrievalEvents: ${error.message}`);
  return count ?? 0;
}

/**
 * Compact rows for fleet-wide aggregation (no context/question text —
 * stats only), bounded so one hot tenant can't blow the admin page.
 */
export async function listKgRetrievalStatsRows(
  sinceIso: string,
  limit = 5000,
  client?: SupabaseClient
): Promise<
  Array<
    Pick<
      KgRetrievalEventRow,
      | "business_id"
      | "mode"
      | "graph_context_chars"
      | "memory_context_chars"
      | "graph_matched_entities"
      | "graph_facts"
      | "memory_fallback"
      | "caller_provided"
    >
  >
> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("kg_retrieval_events")
    .select(
      "business_id, mode, graph_context_chars, memory_context_chars, graph_matched_entities, graph_facts, memory_fallback, caller_provided"
    )
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listKgRetrievalStatsRows: ${error.message}`);
  return (data ?? []) as never;
}

/** Fixed-window prune (daily retention sweep). Returns rows deleted. */
export async function pruneKgRetrievalEvents(
  now: Date = new Date(),
  client?: SupabaseClient
): Promise<number> {
  const db = client ?? (await createSupabaseServiceClient());
  const cutoffIso = new Date(
    now.getTime() - KG_EVENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
  const { data, error } = await db
    .from("kg_retrieval_events")
    .delete()
    .lt("created_at", cutoffIso)
    .select("id");
  if (error) throw new Error(`pruneKgRetrievalEvents: ${error.message}`);
  return Array.isArray(data) ? data.length : 0;
}

/** Mini-summary for the admin business-page card. */
export async function getKgAdminSummary(
  businessId: string,
  client?: SupabaseClient
): Promise<{ entityCount: number; factCount: number; lastEventAt: string | null }> {
  const db = client ?? (await createSupabaseServiceClient());
  const [entities, facts, lastEvent] = await Promise.all([
    db
      .from("memory_entities")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId),
    db
      .from("memory_facts")
      .select("id", { count: "exact", head: true })
      .eq("business_id", businessId)
      .eq("active", true),
    db
      .from("kg_retrieval_events")
      .select("created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);
  if (entities.error) throw new Error(`getKgAdminSummary(entities): ${entities.error.message}`);
  if (facts.error) throw new Error(`getKgAdminSummary(facts): ${facts.error.message}`);
  if (lastEvent.error) throw new Error(`getKgAdminSummary(events): ${lastEvent.error.message}`);
  return {
    entityCount: entities.count ?? 0,
    factCount: facts.count ?? 0,
    lastEventAt: (lastEvent.data as { created_at?: string } | null)?.created_at ?? null
  };
}

// ── Verdicts + aggregates (pure) ─────────────────────────────────────────

export type KgVerdict = "graph_won" | "both" | "memory_only" | "neither";

export const KG_VERDICT_LABELS: Record<KgVerdict, string> = {
  graph_won: "Graph won",
  both: "Both contributed",
  memory_only: "Memory only",
  neither: "Neither relevant"
};

type VerdictInput = Pick<
  KgRetrievalEventRow,
  "graph_context_chars" | "memory_context_chars" | "memory_fallback"
>;

/**
 * Classify one lookup:
 *   graph_won   — the graph had relevant facts while ranked memory either
 *                 found nothing question-relevant (fallback filler) or was
 *                 empty: the graph was the only relevant source.
 *   both        — graph facts AND question-ranked memory both contributed.
 *   memory_only — ranked memory answered; the graph had nothing.
 *   neither     — no graph match and no question-relevant memory.
 */
export function classifyKgVerdict(event: VerdictInput): KgVerdict {
  const graphHit = event.graph_context_chars > 0;
  const memoryRelevant = event.memory_context_chars > 0 && !event.memory_fallback;
  if (graphHit && !memoryRelevant) return "graph_won";
  if (graphHit && memoryRelevant) return "both";
  if (!graphHit && memoryRelevant) return "memory_only";
  return "neither";
}

export type KgStats = {
  lookups: number;
  verdicts: Record<KgVerdict, number>;
  /** % of lookups where the graph contributed anything (graph_won + both). */
  graphContributionRate: number;
  /** % of lookups where the graph was the ONLY relevant source. */
  graphOnlyRate: number;
  avgGraphChars: number;
  avgMemoryChars: number;
  memoryFallbackRate: number;
  callerScopedRate: number;
};

type StatsInput = VerdictInput & { caller_provided: boolean };

export function aggregateKgStats(events: StatsInput[]): KgStats {
  const verdicts: Record<KgVerdict, number> = {
    graph_won: 0,
    both: 0,
    memory_only: 0,
    neither: 0
  };
  let graphChars = 0;
  let memoryChars = 0;
  let fallbacks = 0;
  let callerScoped = 0;
  for (const event of events) {
    verdicts[classifyKgVerdict(event)] += 1;
    graphChars += event.graph_context_chars;
    memoryChars += event.memory_context_chars;
    if (event.memory_fallback) fallbacks += 1;
    if (event.caller_provided) callerScoped += 1;
  }
  const n = events.length;
  const pct = (x: number) => (n === 0 ? 0 : Math.round((x / n) * 100));
  return {
    lookups: n,
    verdicts,
    graphContributionRate: pct(verdicts.graph_won + verdicts.both),
    graphOnlyRate: pct(verdicts.graph_won),
    avgGraphChars: n === 0 ? 0 : Math.round(graphChars / n),
    avgMemoryChars: n === 0 ? 0 : Math.round(memoryChars / n),
    memoryFallbackRate: pct(fallbacks),
    callerScopedRate: pct(callerScoped)
  };
}

/** Per-business stats from a fleet-wide stats-row fetch. */
export function groupKgStatsByBusiness(
  rows: Array<StatsInput & { business_id: string }>
): Map<string, KgStats> {
  const byBusiness = new Map<string, Array<StatsInput & { business_id: string }>>();
  for (const row of rows) {
    const bucket = byBusiness.get(row.business_id);
    if (bucket) bucket.push(row);
    else byBusiness.set(row.business_id, [row]);
  }
  const out = new Map<string, KgStats>();
  for (const [businessId, events] of byBusiness) {
    out.set(businessId, aggregateKgStats(events));
  }
  return out;
}

/** One-line human verdict for the banner. */
export function kgVerdictHeadline(stats: KgStats): string {
  if (stats.lookups === 0) {
    return "No lookups recorded in this window yet — the comparison fills in as real questions arrive.";
  }
  return (
    `Graph contributed on ${stats.graphContributionRate}% of ${stats.lookups} lookups; ` +
    `it was the only relevant source on ${stats.graphOnlyRate}%. ` +
    `Ranked memory fell back to filler on ${stats.memoryFallbackRate}%.`
  );
}
