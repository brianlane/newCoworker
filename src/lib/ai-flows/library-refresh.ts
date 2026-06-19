/**
 * Public AiFlow library refresh (service-role side).
 *
 * Rebuilds the cross-tenant catalog from every flow that has run successfully:
 *   1. aggregate per-flow run stats (RPC, all tenants);
 *   2. group flows by template key (same template across tenants -> one entry);
 *   3. scrub PII from a representative definition (owner + roster names known
 *      to that tenant are redacted along with literal phones/emails);
 *   4. upsert one library entry per group with summed stats.
 *
 * Driven hourly by /api/internal/aiflow-library-refresh (the aiflow-library-
 * refresh Edge cron bridge). Idempotent: re-running reconciles the catalog.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { summarizeDefinition } from "@/lib/ai-flows/schema";
import { redactText, scrubDefinition, templateKeyFromName } from "@/lib/ai-flows/scrub";
import {
  aggregateLibraryCandidates,
  pruneLibraryEntries,
  upsertLibraryEntry,
  type AiFlowLibraryCandidate
} from "@/lib/ai-flows/library";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Friendly category label from a business industry slug. */
function deriveCategory(businessType: string | null): string {
  if (!businessType) return "General";
  const map: Record<string, string> = {
    real_estate: "Real estate",
    mortgage: "Mortgage",
    insurance: "Insurance",
    legal: "Legal",
    home_services: "Home services",
    healthcare: "Healthcare"
  };
  return map[businessType] ?? businessType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Strip a trailing "(copy)" suffix for a clean public title. A non-empty
 *  template_key always implies a non-empty title here (callers skip empty
 *  keys), so no further fallback is needed. */
function cleanTitle(name: string): string {
  return name.replace(/\s*\(copy(?:\s*\d+)?\)\s*$/i, "").trim();
}

/**
 * Build a business_id -> known names ([owner_name, ...roster names]) map for the
 * given businesses, so the scrubber can redact tenant-specific personal names
 * that a regex can't infer. Batched to two queries regardless of group count.
 */
async function loadKnownNames(
  businessIds: string[],
  db: SupabaseClient
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (businessIds.length === 0) return out;
  const push = (id: string, name: unknown) => {
    if (typeof name !== "string" || name.trim().length < 2) return;
    const list = out.get(id) ?? [];
    list.push(name.trim());
    out.set(id, list);
  };
  const [{ data: businesses }, { data: members }] = await Promise.all([
    db.from("businesses").select("id,owner_name").in("id", businessIds),
    db.from("ai_flow_team_members").select("business_id,name").in("business_id", businessIds)
  ]);
  for (const b of businesses ?? []) push(b.id as string, (b as { owner_name?: unknown }).owner_name);
  for (const m of members ?? [])
    push((m as { business_id: string }).business_id, (m as { name?: unknown }).name);
  return out;
}

export type LibraryRefreshResult = { candidates: number; groups: number };

export async function refreshAiFlowLibrary(client?: SupabaseClient): Promise<LibraryRefreshResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const candidates = await aggregateLibraryCandidates(db);

  // Known names must be loaded BEFORE grouping so the grouping key (and later
  // the public title/URL slug) is derived from a PII-redacted name — the same
  // phone/email/known-name redaction applied to the definition. This also makes
  // grouping more robust: "Amy's referral flow" and "Bob's referral flow"
  // redact to the same "[name]'s referral flow" and collapse into one entry.
  const knownNames = await loadKnownNames(
    [...new Set(candidates.map((c) => c.business_id))],
    db
  );
  const redactedNameFor = (c: AiFlowLibraryCandidate): string =>
    redactText(c.name, knownNames.get(c.business_id) ?? []);

  const groups = new Map<string, AiFlowLibraryCandidate[]>();
  for (const c of candidates) {
    const key = templateKeyFromName(redactedNameFor(c));
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }

  for (const [templateKey, members] of groups) {
    // Representative = the most recently successful copy (freshest definition).
    const representative = members.reduce((best, c) =>
      (c.last_done_at ?? "") > (best.last_done_at ?? "") ? c : best
    );

    const totalSuccessfulRuns = members.reduce((n, c) => n + Number(c.done_count), 0);
    const totalRuns = members.reduce((n, c) => n + Number(c.total_count), 0);
    const runsLast7d = members.reduce((n, c) => n + Number(c.done_last_7d), 0);
    const businessesUsing = new Set(members.map((c) => c.business_id)).size;
    const lastRunAt = members.reduce<string | null>(
      (max, c) => ((c.last_done_at ?? "") > (max ?? "") ? c.last_done_at : max),
      null
    );

    const repNames = knownNames.get(representative.business_id) ?? [];
    const scrubbed = scrubDefinition(representative.definition, { knownNames: repNames });

    await upsertLibraryEntry(
      {
        templateKey,
        // Title comes from the redacted name too — never the raw (PII) name.
        title: cleanTitle(redactText(representative.name, repNames)),
        summary: summarizeDefinition(representative.definition),
        category: deriveCategory(representative.business_type),
        scrubbedDefinition: scrubbed,
        totalSuccessfulRuns,
        totalRuns,
        businessesUsing,
        runsLast7d,
        lastRunAt,
        stats: { runsPerDay: Math.round((runsLast7d / 7) * 100) / 100 }
      },
      db
    );
  }

  // Drop catalog entries whose flows no longer qualify (no successful runs).
  await pruneLibraryEntries([...groups.keys()], db);

  return { candidates: candidates.length, groups: groups.size };
}
