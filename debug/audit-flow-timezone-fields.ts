/**
 * audit-flow-timezone-fields.ts: find live extraction fields that make a flow
 * NAME a timezone it had to guess.
 *
 * The failure this catches, KYP Ads on 2026-08-05: an `extract_text` field
 * called `invitee_tz_plain` whose description read "Invitee's timezone in
 * plain words: 'Eastern', 'Central', 'Mountain', 'Pacific', or 'Atlantic'.
 * NEVER return 'none' or blank. If unclear, return 'Eastern'." A lead in
 * `Europe/London` had no correct answer available in that list, so the model
 * took the fallback and the reminder told her a 2:00 PM UK call was "2:00 PM
 * Eastern time (your local time)". She was later told no call was starting
 * while hers was seven minutes away, and she canceled.
 *
 * Two independently dangerous shapes, reported separately because they fail
 * differently:
 *
 *   - CLOSED LIST: a description enumerating zones. Anyone outside the list
 *     gets the nearest wrong one.
 *   - GUESSING FALLBACK: "if unclear, return X". Turns "I do not know" into a
 *     confident wrong answer, which is worse than a blank.
 *
 * Deliberately a DETECTOR and not a rewriter. The engine already post-
 * processes phone-named fields (`postProcessExtractedField`), and that seam
 * has burned us once: `isPhoneFieldName` is a loose NAME heuristic and it
 * clobbered Amy Laidlaw's `phone_lead_type` gate to "none", skipping all
 * three route_to_team steps for 11 leads. A timezone label has no checkable
 * shape at all, so an automatic rewrite would be even harder to make safe.
 * Find them, fix them by hand.
 *
 * The durable fix for a flow that legitimately wants to name a zone is the
 * `invitee timezone label:` line the calendar payload now carries
 * (src/lib/ai-flows/calendly-poll.ts, formatInviteeZoneLabel): copy it,
 * never enumerate.
 *
 *   tsx debug/audit-flow-timezone-fields.ts            # at-risk fields only
 *   tsx debug/audit-flow-timezone-fields.ts --all      # every timezone field
 *   tsx debug/audit-flow-timezone-fields.ts --json     # machine-readable
 *
 * Read-only. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env`.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env)");
  process.exit(1);
}

const showAll = process.argv.includes("--all");
const asJson = process.argv.includes("--json");

type Field = { name?: string; description?: string };
type Step = { id?: string; type?: string; fields?: Field[]; steps?: Step[]; branches?: Step[] };

/**
 * Zone words that only make sense in one part of the world. A description
 * listing several of them is enumerating, not describing.
 */
const REGIONAL_ZONE_WORDS = [
  "eastern",
  "central",
  "mountain",
  "pacific",
  "atlantic",
  "alaska",
  "hawaii"
];

/** Does this field name suggest it holds a timezone? */
export function isTimezoneFieldName(name: string): boolean {
  const tokens = name
    .split(/[^a-zA-Z]+|(?<=[a-z])(?=[A-Z])/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
  if (tokens.includes("tz") || tokens.includes("timezone")) return true;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "time" && tokens[i + 1] === "zone") return true;
  }
  return false;
}

/** Zones the description hands the model to choose between. */
export function enumeratedZones(description: string): string[] {
  const lower = description.toLowerCase();
  return REGIONAL_ZONE_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(lower));
}

/** "If unclear, return 'Eastern'" and friends. */
export function guessingFallback(description: string): string | null {
  const m =
    /\b(?:if\s+(?:unclear|unknown|uncertain|in\s+doubt)|when\s+(?:unclear|unknown)|otherwise|by\s+default|default(?:s)?\s+to)\b[^.]*/i.exec(
      description
    );
  return m ? m[0].trim() : null;
}

function collectFields(steps: Step[], acc: Array<{ step: Step; field: Field }>): void {
  for (const step of steps ?? []) {
    if (step.type === "extract_text" && Array.isArray(step.fields)) {
      for (const field of step.fields) acc.push({ step, field });
    }
    if (Array.isArray(step.steps)) collectFields(step.steps, acc);
    if (Array.isArray(step.branches)) collectFields(step.branches, acc);
  }
}

type Finding = {
  business: string;
  businessName: string;
  flow: string;
  flowName: string;
  enabled: boolean;
  step: string;
  field: string;
  description: string;
  enumerated: string[];
  fallback: string | null;
  atRisk: boolean;
};

async function main(): Promise<void> {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: businesses } = await db.from("businesses").select("id, name");
  const nameOf = new Map((businesses ?? []).map((b) => [b.id as string, String(b.name ?? "?")]));

  const { data: flows, error } = await db
    .from("ai_flows")
    .select("id, business_id, name, enabled, definition");
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }

  const findings: Finding[] = [];
  for (const flow of flows ?? []) {
    const definition = flow.definition as { steps?: Step[] } | null;
    const acc: Array<{ step: Step; field: Field }> = [];
    collectFields(definition?.steps ?? [], acc);
    for (const { step, field } of acc) {
      const name = String(field.name ?? "");
      const description = String(field.description ?? "");
      if (!isTimezoneFieldName(name)) continue;
      const enumerated = enumeratedZones(description);
      const fallback = guessingFallback(description);
      const atRisk = enumerated.length > 0 || fallback !== null;
      if (!atRisk && !showAll) continue;
      findings.push({
        business: String(flow.business_id),
        businessName: nameOf.get(String(flow.business_id)) ?? "?",
        flow: String(flow.id),
        flowName: String(flow.name),
        enabled: Boolean(flow.enabled),
        step: String(step.id ?? "?"),
        field: name,
        description,
        enumerated,
        fallback,
        atRisk
      });
    }
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ scanned: flows?.length ?? 0, findings }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\nScanned ${flows?.length ?? 0} flows.\n`);
  if (findings.length === 0) {
    process.stdout.write(
      showAll
        ? "No timezone-named extraction fields at all.\n"
        : "No at-risk timezone fields. (Re-run with --all to see every timezone field.)\n"
    );
    return;
  }

  for (const f of findings) {
    const flag = f.atRisk ? "AT RISK" : "ok";
    process.stdout.write(
      `\n[${flag}] ${f.businessName} / ${f.flowName} (enabled=${f.enabled})\n` +
        `  step ${f.step}, field "${f.field}"\n` +
        `  ${f.description}\n`
    );
    if (f.enumerated.length > 0) {
      process.stdout.write(
        `  -> CLOSED LIST: enumerates ${f.enumerated.join(", ")}. An invitee outside that ` +
          "list gets the nearest wrong one.\n"
      );
    }
    if (f.fallback) {
      process.stdout.write(
        `  -> GUESSING FALLBACK: "${f.fallback}". This turns "I do not know" into a ` +
          "confident wrong answer.\n"
      );
    }
  }

  const atRisk = findings.filter((f) => f.atRisk).length;
  if (atRisk > 0) {
    process.stdout.write(
      `\n${atRisk} at-risk field(s). Fix by copying the payload's ` +
        `"invitee timezone label:" line verbatim instead of enumerating zones, or by ` +
        "dropping the zone entirely (the invitee-local time already needs none).\n"
    );
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
