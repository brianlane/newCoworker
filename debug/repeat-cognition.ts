#!/usr/bin/env tsx
/**
 * Where are we paying a model to re-derive an answer we already have?
 *
 * The development-side version of this question is answered by
 * `scripts/context-pack.ts` and the tenant dossiers. This is the RUNTIME
 * version: it reads the two ledgers the platform already keeps and reports
 * which LLM call sites are repeating themselves, so the repetition can be
 * replaced with something deterministic (a cache, a lookup, a branch) instead
 * of being re-bought per call.
 *
 * Two reports:
 *
 *   1. **Repeated knowledge lookups.** `kg_retrieval_events` stores the
 *      question and answer of every `business_knowledge_lookup` on a
 *      shadow/active tenant. Questions are normalized and grouped, so
 *      "What are your hours?" and "what are your hours" count together.
 *      A question asked N times with a stable answer is N-1 Gemini calls
 *      that bought nothing. Answer stability is reported too: a group whose
 *      answers vary is NOT a cache candidate, and saying so is the point.
 *
 *   2. **Spend by surface.** `gemini_spend_daily` rolled up per surface and
 *      model with cost and call count, highest spend first. This is where to
 *      look for the next candidate once the obvious one is handled: a
 *      high-call-count, low-variance surface is a deterministic-replacement
 *      opportunity (the template is the bare-acknowledgment suppression in
 *      PR #826, which stopped paying for replies to "ok").
 *
 * Strictly READ-ONLY. No writes, no sends, no model calls: it reads ledgers.
 *
 * Usage:
 *   tsx debug/repeat-cognition.ts                          # fleet, last 30 days
 *   tsx debug/repeat-cognition.ts --business <uuid> --days 7
 *   tsx debug/repeat-cognition.ts --min-repeats 3 --json
 *
 * Env (repo-root `.env`): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";

type Args = { businessId: string | null; days: number; minRepeats: number; json: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { businessId: null, days: 30, minRepeats: 2, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--business") out.businessId = argv[++i] ?? null;
    else if (a === "--days") out.days = Number(argv[++i] ?? "30") || 30;
    else if (a === "--min-repeats") out.minRepeats = Number(argv[++i] ?? "2") || 2;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: tsx debug/repeat-cognition.ts [--business <uuid>] [--days 30] [--min-repeats 2] [--json]\n"
      );
      process.exit(0);
    }
  }
  return out;
}

/**
 * Fold away the differences that do not change what is being asked, so the
 * same question typed two ways groups together. Deliberately conservative:
 * case, punctuation, and whitespace only. Stemming or synonyms would merge
 * questions with genuinely different answers and overstate the opportunity.
 */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type RepeatGroup = {
  businessId: string;
  question: string;
  asked: number;
  distinctAnswers: number;
  /** True when every occurrence produced the same answer: a safe cache candidate. */
  stable: boolean;
  lastAskedAt: string;
};

export function groupRepeatedQuestions(
  rows: Array<{ business_id: string; question: string; answer: string; created_at: string }>,
  minRepeats: number
): RepeatGroup[] {
  const groups = new Map<
    string,
    { businessId: string; sample: string; count: number; answers: Set<string>; last: string }
  >();
  for (const row of rows) {
    const normalized = normalizeQuestion(row.question);
    if (!normalized) continue;
    const key = `${row.business_id}::${normalized}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.answers.add(row.answer.trim());
      if (row.created_at > existing.last) existing.last = row.created_at;
    } else {
      groups.set(key, {
        businessId: row.business_id,
        sample: row.question.trim(),
        count: 1,
        answers: new Set([row.answer.trim()]),
        last: row.created_at
      });
    }
  }
  return [...groups.values()]
    .filter((g) => g.count >= minRepeats)
    .map((g) => ({
      businessId: g.businessId,
      question: g.sample,
      asked: g.count,
      distinctAnswers: g.answers.size,
      stable: g.answers.size === 1,
      lastAskedAt: g.last
    }))
    .sort((a, b) => b.asked - a.asked);
}

export function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

type SurfaceRow = { surface: string; model: string; cost_micros: number; call_count: number };

export type SurfaceSummary = {
  surface: string;
  models: string[];
  calls: number;
  costMicros: number;
  microsPerCall: number;
};

export function summarizeSurfaces(rows: SurfaceRow[]): SurfaceSummary[] {
  const bySurface = new Map<string, { models: Set<string>; calls: number; micros: number }>();
  for (const row of rows) {
    const cur = bySurface.get(row.surface) ?? { models: new Set<string>(), calls: 0, micros: 0 };
    cur.models.add(row.model);
    cur.calls += row.call_count;
    cur.micros += row.cost_micros;
    bySurface.set(row.surface, cur);
  }
  return [...bySurface.entries()]
    .map(([surface, v]) => ({
      surface,
      models: [...v.models].sort(),
      calls: v.calls,
      costMicros: v.micros,
      microsPerCall: v.calls > 0 ? Math.round(v.micros / v.calls) : 0
    }))
    .sort((a, b) => b.costMicros - a.costMicros);
}

/** Page through the ledger: a 30-day fleet window exceeds the 1000-row default. */
async function fetchAllEvents(
  db: SupabaseClient,
  sinceIso: string,
  businessId: string | null
): Promise<Array<{ business_id: string; question: string; answer: string; created_at: string }>> {
  const page = 1000;
  const all: Array<{ business_id: string; question: string; answer: string; created_at: string }> = [];
  for (let from = 0; ; from += page) {
    let q = db
      .from("kg_retrieval_events")
      .select("business_id,question,answer,created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .range(from, from + page - 1);
    if (businessId) q = q.eq("business_id", businessId);
    const { data, error } = await q;
    if (error) throw new Error(`kg_retrieval_events: ${error.message}`);
    const rows = (data ?? []) as typeof all;
    all.push(...rows);
    if (rows.length < page) return all;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadEnv();

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    process.stderr.write("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (repo-root .env)\n");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const sinceIso = new Date(Date.now() - args.days * 86_400_000).toISOString();
  const events = await fetchAllEvents(db, sinceIso, args.businessId);
  const groups = groupRepeatedQuestions(events, args.minRepeats);

  let spendQuery = db
    .from("gemini_spend_daily")
    .select("surface,model,cost_micros,call_count")
    .gte("day", sinceIso.slice(0, 10));
  if (args.businessId) spendQuery = spendQuery.eq("business_id", args.businessId);
  const spend = await spendQuery;
  if (spend.error) throw new Error(`gemini_spend_daily: ${spend.error.message}`);
  const surfaces = summarizeSurfaces((spend.data ?? []) as SurfaceRow[]);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ sinceIso, groups, surfaces }, null, 2)}\n`);
    return;
  }

  const out = process.stdout;
  out.write(`\n=== Repeated knowledge lookups (last ${args.days} days, >= ${args.minRepeats} asks)\n`);
  out.write(`    ${events.length} lookups recorded in kg_retrieval_events.\n`);
  if (events.length === 0) {
    out.write(
      "    Note: only shadow/active memory-graph tenants write this ledger, so an\n" +
        "    empty result may mean no tenant is enrolled rather than no repetition.\n"
    );
  }
  if (groups.length === 0) {
    out.write("    No repeated questions. Nothing to cache: the spend is buying new answers.\n");
  } else {
    const stable = groups.filter((g) => g.stable);
    const wasted = stable.reduce((sum, g) => sum + (g.asked - 1), 0);
    out.write(
      `    ${groups.length} repeated question(s); ${stable.length} produced an identical answer every time,\n` +
        `    which is ${wasted} model call(s) that bought nothing.\n\n`
    );
    for (const g of groups.slice(0, 25)) {
      const verdict = g.stable ? "stable, cacheable" : `${g.distinctAnswers} different answers, NOT cacheable`;
      out.write(`    ${String(g.asked).padStart(3)}x  [${verdict}]  ${g.businessId.slice(0, 8)}  ${g.question}\n`);
    }
  }

  out.write(`\n=== Gemini spend by surface (last ${args.days} days)\n`);
  if (surfaces.length === 0) out.write("    none recorded\n");
  else {
    out.write("       cost     calls    per call  surface\n");
    for (const s of surfaces) {
      out.write(
        `    ${formatUsd(s.costMicros).padStart(9)}  ${String(s.calls).padStart(7)}  ` +
          `${formatUsd(s.microsPerCall).padStart(9)}  ${s.surface} (${s.models.join(", ")})\n`
      );
    }
  }

  out.write(
    "\nReading this: a surface with many calls and low output variance is a candidate\n" +
      "for deterministic replacement, not a cheaper model. The template is PR #826,\n" +
      "which stopped paying to generate replies to bare acknowledgments.\n\n"
  );
}

if (process.argv[1] && process.argv[1].endsWith("repeat-cognition.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`repeat-cognition failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
