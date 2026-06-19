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
import {
  containsLikelyPii,
  redactText,
  scrubDefinition,
  templateKeyFromName
} from "@/lib/ai-flows/scrub";
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
 * Generic words to drop when tokenizing a business name so we redact the
 * identifying parts ("Amy", "Laidlaw") without nuking common nouns ("Real",
 * "Estate") that legitimately appear in flow titles.
 */
const BUSINESS_NAME_STOPWORDS: ReadonlySet<string> = new Set([
  "real",
  "estate",
  "realty",
  "realtor",
  "realtors",
  "group",
  "team",
  "homes",
  "home",
  "properties",
  "property",
  "company",
  "co",
  "agency",
  "agent",
  "agents",
  "brokerage",
  "services",
  "solutions",
  "the",
  "and",
  "llc",
  "inc"
]);

type KnownNames = {
  /** Owner + roster names — used to redact the (kept) definition strings. */
  body: Map<string, string[]>;
  /** body names PLUS business-name tokens — used only to redact the title. */
  title: Map<string, string[]>;
};

/**
 * Build per-business known-name lists so the scrubber can redact tenant-specific
 * personal names a regex can't infer. Two scopes:
 *   - `body`  = owner_name + roster names (conservative; applied to the whole
 *               definition, where an over-broad token could corrupt a var name);
 *   - `title` = body names + tokens of the business display name, applied only
 *               to the short flow title/slug (e.g. business "Amy Laidlaw Real
 *               Estate" redacts "Amy"/"Laidlaw" from a title without touching
 *               "Real"/"Estate"). Batched to two queries regardless of count.
 */
async function loadKnownNames(businessIds: string[], db: SupabaseClient): Promise<KnownNames> {
  const body = new Map<string, string[]>();
  const title = new Map<string, string[]>();
  if (businessIds.length === 0) return { body, title };
  const push = (map: Map<string, string[]>, id: string, name: unknown) => {
    if (typeof name !== "string" || name.trim().length < 2) return;
    const list = map.get(id) ?? [];
    list.push(name.trim());
    map.set(id, list);
  };
  const pushBoth = (id: string, name: unknown) => {
    push(body, id, name);
    push(title, id, name);
  };
  const [{ data: businesses }, { data: members }] = await Promise.all([
    db.from("businesses").select("id,owner_name,name").in("id", businessIds),
    db.from("ai_flow_team_members").select("business_id,name").in("business_id", businessIds)
  ]);
  for (const b of businesses ?? []) {
    const id = b.id as string;
    pushBoth(id, (b as { owner_name?: unknown }).owner_name);
    // Business display name: title-only (whole name + identifying tokens).
    const bizName = (b as { name?: unknown }).name;
    push(title, id, bizName);
    if (typeof bizName === "string") {
      for (const tok of bizName.split(/[^A-Za-z]+/)) {
        if (tok.length >= 2 && !BUSINESS_NAME_STOPWORDS.has(tok.toLowerCase())) push(title, id, tok);
      }
    }
  }
  for (const m of members ?? [])
    pushBoth((m as { business_id: string }).business_id, (m as { name?: unknown }).name);
  return { body, title };
}

export type LibraryRefreshResult = {
  candidates: number;
  groups: number;
  /** Entries actually upserted (groups minus any blocked by the PII gate). */
  published: number;
  /** Templates skipped because the scrubbed result still tripped the PII gate. */
  skipped: number;
};

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
    redactText(c.name, knownNames.title.get(c.business_id) ?? []);

  const groups = new Map<string, AiFlowLibraryCandidate[]>();
  for (const c of candidates) {
    const key = templateKeyFromName(redactedNameFor(c));
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }

  let published = 0;
  let skipped = 0;
  const publishedKeys: string[] = [];
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

    const bid = representative.business_id;
    const scrubbed = scrubDefinition(representative.definition, {
      knownNames: knownNames.body.get(bid) ?? []
    });

    // Defense-in-depth: never publish a definition that still trips the PII
    // gate (a missed prose field, an unexpected literal). The template just
    // stays out of the library until its source flow is cleaned up.
    if (containsLikelyPii(scrubbed)) {
      skipped += 1;
      continue;
    }

    await upsertLibraryEntry(
      {
        templateKey,
        // Title comes from the redacted name too — never the raw (PII) name.
        title: cleanTitle(redactText(representative.name, knownNames.title.get(bid) ?? [])),
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
    published += 1;
    publishedKeys.push(templateKey);
  }

  // Drop catalog entries whose flows no longer qualify (no successful runs) or
  // were withheld by the PII gate — keep only what we actually published.
  await pruneLibraryEntries(publishedKeys, db);

  return { candidates: candidates.length, groups: groups.size, published, skipped };
}
