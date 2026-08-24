#!/usr/bin/env tsx
/**
 * One-shot: make "Clever Lead - Accept" read a BUYER's budget range, so the
 * price gates that sort Amy's leads work for buyers too.
 *
 * The gates. Two numbers decide what happens to a Clever lead:
 * `price_gate` ($500K+ goes to the team, under is AI-owned) and
 * `price_under_1m` (computed from `price_digits`, and $1M+ is kept for Amy
 * rather than offered at all). Between them they gate five steps, including
 * both routes' `ownerDirectWhen` and the AI call itself.
 *
 * Both are worded for a seller: "the estimated home value or price shown on
 * the lead page". A seller referral shows one figure ("Est. Home Value:
 * $825,000.00"). A BUYER referral shows a range instead ("Est. Price Range:
 * 0 to 200000", "Est. Price Range: 300000 to 300000"), and none of these
 * descriptions says what to do with two numbers. `price_gate` then falls to
 * its own written default, "answer ai when no value or price is shown
 * anywhere", so a buyer is AI-owned no matter what their budget is: a $1.2M
 * buyer is never kept for Amy, and never reaches the team.
 *
 * A correction to what the earlier dossier entry claimed. It cited the two
 * real buyer runs (Jul 8 and Jul 31 2026) as evidence that the extraction
 * comes back empty for buyers. That evidence does not support it:
 * `price_gate` first appears in a run on 2026-08-13 and `price_digits` on
 * 2026-08-14, so on those July runs the fields did not exist yet, which is why
 * they are blank. There has been NO Clever buyer since the gates were added,
 * so how they behave on a real buyer page is untested rather than known
 * broken. What IS certain is the wording: it asks for one figure and says
 * nothing about a range.
 *
 * The rule this adds, in three places: when the page shows a RANGE, judge it
 * by the TOP. Reasons, in order:
 *   - The top is the buyer's ceiling, which is what "how big is this lead"
 *     means for someone shopping.
 *   - It is the human-first direction. Reading the top sends MORE leads to a
 *     teammate and keeps more high-dollar ones with Amy; reading the bottom
 *     would quietly hand a $1.2M buyer with a wide range to the AI.
 *   - A single figure is unaffected, so all 116 seller runs behave exactly as
 *     they do today.
 *
 * `price_band` is deliberately left alone: nothing in the flow reads it (every
 * gate goes through `price_gate` or `price_under_1m`), and rewording a field
 * with no consumers is churn that reads like a fix.
 *
 * What changes downstream, stated because it is a real behavior change and
 * not a detail. Once `price_gate` resolves for a buyer:
 *   - a $500K+ buyer reaches `route_buyer` and the buyer rotation, which
 *     today they never do;
 *   - a $1M+ buyer is kept for Amy by `route_buyer.ownerDirectWhen`, which
 *     today never fires for a buyer;
 *   - an under-$500K buyer becomes AI-owned, which is Amy's own rule. Traced
 *     against the live definition: `clever_gated_after_call` runs, no call arm
 *     matches (the AI call is gated off for buyers), so the else tags them
 *     "Needs Follow Up" carrying `lead_type: {{vars.lead_type}}` and the
 *     cadence works them as a buyer. Nobody is stranded.
 *
 * Refuses to overwrite a description that is neither the text it expects nor
 * the text it wants, so a hand edit in the builder is never silently lost
 * (--force overrides). Idempotent, dry-run by default, ledger-recorded,
 * --revert restores the previous wording exactly. Enqueues nothing, sends
 * nothing, and touches no step other than `read_details`.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-clever-buyer-price-range.ts --business <uuid>
 *   npx tsx scripts/oneshot/amy-clever-buyer-price-range.ts --business <uuid> --apply
 *   npx tsx scripts/oneshot/amy-clever-buyer-price-range.ts --business <uuid> --revert --apply
 */
import { CLEVER_FLOW_NAME, walkSteps } from "./amy-clever-lead-type";

export { CLEVER_FLOW_NAME };

/** The extraction step that reads the Clever referral page. */
export const READ_STEP_ID = "read_details";

/**
 * The schema cap on an extract field description (`extractFieldSchema`).
 * Worth naming: the first draft of this patch read well and was rejected
 * outright, because two of the three descriptions came out over 300 and a
 * `parseAiFlowDefinition` failure says only "Invalid AiFlow definition".
 */
export const DESCRIPTION_MAX = 300;

/**
 * One entry per field: what it should say, and what it said before, so the
 * script can tell "already done" from "somebody edited this" and can put the
 * old wording back exactly.
 *
 * Every gate spells the range rule out for itself rather than sharing one
 * sentence. Within 300 characters a shared clause does not fit three times,
 * and the rule reads differently at each site anyway: `price` keeps the range
 * verbatim because it only ever prints, while the two GATES collapse it to
 * the top because a gate needs one number.
 *
 * `price_band` is absent on purpose: nothing reads it.
 */
export const FIELD_EDITS: ReadonlyArray<{ name: string; wanted: string; previous: string }> = [
  {
    name: "price",
    previous:
      "The estimated home value or price shown on the lead page (e.g. $425,000). " +
      "This is the same figure price_band is judged from. If no value is shown, answer exactly: none",
    // The dropped clause ("the same figure price_band is judged from") pointed
    // at a field nothing reads, and the characters are needed here.
    wanted:
      "The home value, price, or buyer budget shown on the lead page (e.g. $425,000). " +
      'A RANGE (a buyer\'s budget) is answered exactly as written, e.g. "300000 to 450000", ' +
      "rather than picking one end. If no value is shown, answer exactly: none"
  },
  {
    name: "price_gate",
    previous:
      "Answer exactly one lowercase word: team or ai. Answer team when the estimated home " +
      "value or price shown is $500,000 or more. Answer ai when it is under $500,000 or when " +
      "no value or price is shown anywhere.",
    wanted:
      "Answer exactly one lowercase word: team or ai. Answer team when the home value, price, " +
      'or buyer budget is $500,000 or more, judging a RANGE by its TOP (a buyer\'s "300000 to ' +
      '600000" is 600000). Answer ai when it is under $500,000, or when nothing is shown.'
  },
  {
    name: "price_digits",
    previous:
      "The price, home value, or budget as BARE DIGITS with no symbols, commas, letters, or " +
      "words (e.g. 613000 for $613K, 1200000 for $1.2M). If no price or value is given " +
      "anywhere, answer exactly: 0",
    wanted:
      "The price, home value, or budget as BARE DIGITS, no symbols, commas, letters or words " +
      '(613000 for $613K, 1200000 for $1.2M). For a RANGE (a buyer\'s budget) answer its TOP: ' +
      '"300000 to 450000" is 450000. If no price or value is given anywhere, answer exactly: 0'
  }
];

type AnyStep = Record<string, unknown> & { id?: unknown };
type AnyDef = { steps?: unknown } & Record<string, unknown>;
type Field = Record<string, unknown> & { name?: unknown; description?: unknown };

/** The fields of `read_details`, or null when the step is gone. */
export function readFields(def: AnyDef): Field[] | null {
  const step = walkSteps(def.steps).find((s) => s.id === READ_STEP_ID);
  if (!step || !Array.isArray(step.fields)) return null;
  return step.fields as Field[];
}

/**
 * Rewrite the three descriptions in place.
 *
 * `direction` picks which way: "apply" installs the range rule, "revert" puts
 * the previous wording back. Both refuse a description they do not recognise,
 * because overwriting a hand edit made in the builder would destroy work with
 * no trace, and this flow is edited by hand.
 */
export function patchPriceFields(
  def: AnyDef,
  direction: "apply" | "revert",
  force = false
): { changed: string[]; problems: string[] } {
  const changed: string[] = [];
  const problems: string[] = [];
  const fields = readFields(def);
  if (!fields) {
    problems.push(`"${READ_STEP_ID}" is missing, or has no fields`);
    return { changed, problems };
  }
  for (const edit of FIELD_EDITS) {
    const field = fields.find((f) => f.name === edit.name);
    if (!field) {
      problems.push(`field "${edit.name}" is missing from ${READ_STEP_ID}`);
      continue;
    }
    const target = direction === "apply" ? edit.wanted : edit.previous;
    const from = direction === "apply" ? edit.previous : edit.wanted;
    const current = typeof field.description === "string" ? field.description : "";
    if (current === target) continue;
    if (current !== from && !force) {
      problems.push(
        `field "${edit.name}" has a description this script does not recognise, so it will not ` +
          "be overwritten (somebody may have edited it by hand). Re-run with --force to replace it."
      );
      continue;
    }
    field.description = target;
    changed.push(`${READ_STEP_ID}.${edit.name}: description ${direction === "apply" ? "now reads a range by its top" : "restored"}`);
  }
  return { changed, problems };
}

/* c8 ignore start -- the IO shell; the pure patch above is tested */

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import("../../debug/_shared.ts");
  loadEnv();
  const { createClient } = await import("@supabase/supabase-js");
  const { parseAiFlowDefinition, summarizeDefinition } = await import(
    "../../src/lib/ai-flows/schema.ts"
  );
  const { recordOneshotApplied } = await import("./_ledger.ts");

  const argOf = (name: string): string | null => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : null;
  };
  const APPLY = process.argv.includes("--apply");
  const REVERT = process.argv.includes("--revert");
  const FORCE = process.argv.includes("--force");
  const BUSINESS_ID = argOf("business");
  if (!BUSINESS_ID) {
    console.error(
      "Usage: tsx scripts/oneshot/amy-clever-buyer-price-range.ts --business <uuid> [--apply] [--revert] [--force]"
    );
    process.exit(2);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", CLEVER_FLOW_NAME)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    console.error(`flow read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`"${CLEVER_FLOW_NAME}" not found on business ${BUSINESS_ID}.`);
    process.exit(2);
  }

  // Only descriptions change, and no step id moves, so a parked run resumes
  // exactly where it was. Reported rather than blocking.
  const { data: live } = await db
    .from("ai_flow_runs")
    .select("id,status")
    .eq("flow_id", row.id)
    .not("status", "in", '("done","failed","canceled")');
  if ((live ?? []).length > 0) {
    console.log(
      `note: ${(live ?? []).length} run(s) in flight. Only field descriptions change and no step ` +
        "id moves, so their resume markers still resolve; a run past read_details keeps the " +
        "values it already extracted."
    );
  }

  const next = JSON.parse(JSON.stringify(row.definition)) as AnyDef;
  const { changed, problems } = patchPriceFields(next, REVERT ? "revert" : "apply", FORCE);

  if (problems.length > 0) {
    console.error("\nNothing was written:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }

  console.log(`=== ${row.name} (id=${row.id}, enabled=${row.enabled}) ===`);
  if (changed.length === 0) {
    console.log(REVERT ? "  nothing to revert" : "  already patched, no changes");
    process.exit(0);
  }
  for (const c of changed) console.log(`  - ${c}`);
  for (const edit of FIELD_EDITS) {
    const f = (readFields(next) ?? []).find((x) => x.name === edit.name);
    console.log(`\n  ${edit.name}:\n    ${String(f?.description)}`);
  }

  let validated;
  try {
    validated = parseAiFlowDefinition(next);
  } catch (e) {
    console.error(`\nwould not validate after patching: ${String(e)}`);
    process.exit(1);
  }
  console.log(`\n  after: ${summarizeDefinition(validated)}`);

  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    process.exit(0);
  }

  const { data: updated, error: upErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id)
    .eq("business_id", BUSINESS_ID)
    .select("id");
  if (upErr) {
    console.error(`update failed: ${upErr.message}`);
    process.exit(1);
  }
  if ((updated ?? []).length !== 1) {
    console.error(`update matched ${(updated ?? []).length} rows; NOT written.`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "amy-clever-buyer-price-range.ts",
    businessId: BUSINESS_ID,
    details: { flow_id: row.id, fields: FIELD_EDITS.map((f) => f.name), reverted: REVERT }
  });
  console.log(
    REVERT
      ? "\nReverted. The price gates read a single figure again."
      : "\nDone. A buyer's budget range now sorts them by the same $500K and $1M rules as a seller."
  );
}

/* c8 ignore stop */
