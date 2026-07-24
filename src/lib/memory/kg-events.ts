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
  /** Wall-clock ms of the ranked-markdown selection (null pre-migration). */
  memory_retrieval_ms?: number | null;
  /** Wall-clock ms of the graph retrieval (null pre-migration). */
  graph_retrieval_ms?: number | null;
  /** Attributed "(unverified)" claim lines in graph_context (null pre-migration). */
  graph_claims?: number | null;
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
      "business_id, mode, graph_context_chars, memory_context_chars, graph_matched_entities, graph_facts, memory_fallback, caller_provided, memory_retrieval_ms, graph_retrieval_ms, graph_claims"
    )
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listKgRetrievalStatsRows: ${error.message}`);
  return (data ?? []) as never;
}

// ── Extraction spend (gemini_spend_daily, surface = memory_graph) ────────

export type KgExtractionSpend = { calls: number; costMicros: number };

/**
 * Per-business graph-extraction spend since `sinceDay` (YYYY-MM-DD, UTC),
 * read from the same roll-up the admin Gemini page bills against — the
 * dashboard's cost tiles and the daily fuse can never disagree with the
 * bill. NOTE: the roll-up is UTC-DAY grained, so callers comparing against
 * a rolling event window must label the cost as covering whole UTC
 * calendar days. Paged in 1000-row chunks — PostgREST silently caps a
 * single request at 1000 rows (same trap listGeminiSpendDaily guards).
 */
export async function listKgExtractionSpend(
  sinceDay: string,
  client?: SupabaseClient
): Promise<Map<string, KgExtractionSpend>> {
  const db = client ?? (await createSupabaseServiceClient());
  const pageSize = 1000;
  const out = new Map<string, KgExtractionSpend>();
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("gemini_spend_daily")
      .select("business_id, call_count, cost_micros")
      .eq("surface", "memory_graph")
      .gte("day", sinceDay)
      .order("day", { ascending: true })
      .order("business_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`listKgExtractionSpend: ${error.message}`);
    const rows = (data ?? []) as Array<{
      business_id: string;
      call_count: number;
      cost_micros: number;
    }>;
    for (const row of rows) {
      const prior = out.get(row.business_id) ?? { calls: 0, costMicros: 0 };
      out.set(row.business_id, {
        calls: prior.calls + row.call_count,
        costMicros: prior.costMicros + row.cost_micros
      });
    }
    if (rows.length < pageSize) break;
  }
  return out;
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

/**
 * A trust <= 1 fact renders with this marker (graph-retrieval.ts +
 * graph-projection.ts share the contract) — the deterministic hook the
 * claim flagging and the keep-verdict's quality qualifier both key on.
 */
const UNVERIFIED_CLAIM_MARKER = "(unverified)";

/** Lines in a graph context that are attributed, unverified claims. */
export function countUnverifiedClaims(graphContext: string): number {
  if (!graphContext) return 0;
  return graphContext
    .split("\n")
    .filter((line) => line.includes(UNVERIFIED_CLAIM_MARKER)).length;
}

/** Is this graph-context line an attributed claim (for amber rendering)? */
export function isUnverifiedClaimLine(line: string): boolean {
  return line.includes(UNVERIFIED_CLAIM_MARKER);
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
  /** Avg ranked-memory selection ms over MEASURED rows (null: none measured). */
  avgMemoryMs: number | null;
  /** Avg graph retrieval ms over MEASURED rows (null: none measured). */
  avgGraphMs: number | null;
  /**
   * % of graph-contributing lookups whose graph context leaned on
   * attributed unverified claims — the keep-verdict's quality qualifier.
   * null when the graph contributed nothing (no basis to judge).
   */
  claimReliance: number | null;
};

type StatsInput = VerdictInput & {
  caller_provided: boolean;
  memory_retrieval_ms?: number | null;
  graph_retrieval_ms?: number | null;
  /** Persisted claim count (compact stats rows); null pre-migration. */
  graph_claims?: number | null;
  /** Optional: only full event rows carry the context text (fallback). */
  graph_context?: string;
};

/** Claim count for one event: persisted count, else re-derived from text. */
function eventClaims(event: StatsInput): number {
  if (typeof event.graph_claims === "number") return event.graph_claims;
  if (typeof event.graph_context === "string") return countUnverifiedClaims(event.graph_context);
  return 0;
}

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
  let memoryMsSum = 0;
  let memoryMsCount = 0;
  let graphMsSum = 0;
  let graphMsCount = 0;
  let graphContributing = 0;
  let claimLeaning = 0;
  for (const event of events) {
    verdicts[classifyKgVerdict(event)] += 1;
    graphChars += event.graph_context_chars;
    memoryChars += event.memory_context_chars;
    if (event.memory_fallback) fallbacks += 1;
    if (event.caller_provided) callerScoped += 1;
    if (typeof event.memory_retrieval_ms === "number") {
      memoryMsSum += event.memory_retrieval_ms;
      memoryMsCount += 1;
    }
    if (typeof event.graph_retrieval_ms === "number") {
      graphMsSum += event.graph_retrieval_ms;
      graphMsCount += 1;
    }
    if (event.graph_context_chars > 0) {
      graphContributing += 1;
      if (eventClaims(event) > 0) claimLeaning += 1;
    }
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
    callerScopedRate: pct(callerScoped),
    avgMemoryMs: memoryMsCount === 0 ? null : Math.round(memoryMsSum / memoryMsCount),
    avgGraphMs: graphMsCount === 0 ? null : Math.round(graphMsSum / graphMsCount),
    claimReliance:
      graphContributing === 0 ? null : Math.round((claimLeaning / graphContributing) * 100)
  };
}

// ── "Earning its keep" verdict ───────────────────────────────────────────

export type KgKeepVerdict =
  | "insufficient_data"
  | "earning"
  | "earning_on_claims"
  | "borderline"
  | "not_earning";

/** Minimum lookups before a keep-verdict is rendered at all. */
export const KG_KEEP_MIN_LOOKUPS = 20;
/** graph-won rate (%) at/above which the graph is earning its keep. */
export const KG_KEEP_EARNING_PCT = 10;
/** graph-won rate (%) below which the graph is not earning its keep. */
export const KG_KEEP_BORDERLINE_PCT = 3;
/** claimReliance (%) above which an 'earning' verdict downgrades. */
export const KG_KEEP_CLAIM_RELIANCE_PCT = 50;

export const KG_KEEP_LABELS: Record<KgKeepVerdict, string> = {
  insufficient_data: "Verdict pending",
  earning: "Earning its keep",
  earning_on_claims: "Earning, on claims",
  borderline: "Borderline",
  not_earning: "Not earning its keep"
};

/**
 * Is the graph layer earning its keep for this tenant/window?
 *
 * Quantity: the graph-won rate — lookups where ranked memory fell back to
 * filler while the graph matched real facts, i.e. answers that would have
 * been materially better with the graph active.
 * Quality (one-way DOWNGRADE only): an 'earning' verdict whose wins lean
 * mostly on attributed unverified claims (claimReliance) drops to
 * 'earning_on_claims' — hearsay-built win rates never show clean green.
 * What no classifier can see: WRONG plain facts parse identically to right
 * ones, so correctness spot-checks in the side-by-side stay human.
 */
export function kgKeepVerdict(
  stats: Pick<KgStats, "lookups" | "graphOnlyRate" | "claimReliance">,
  minLookups = KG_KEEP_MIN_LOOKUPS
): KgKeepVerdict {
  if (stats.lookups < minLookups) return "insufficient_data";
  if (stats.graphOnlyRate >= KG_KEEP_EARNING_PCT) {
    return (stats.claimReliance ?? 0) > KG_KEEP_CLAIM_RELIANCE_PCT
      ? "earning_on_claims"
      : "earning";
  }
  if (stats.graphOnlyRate >= KG_KEEP_BORDERLINE_PCT) return "borderline";
  return "not_earning";
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
